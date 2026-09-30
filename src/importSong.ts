import type { Song } from "./types";

export type ImportProgress = {
  status: "submitting" | "queued" | "processing" | "reconnecting";
  message: string;
};
export type ImportResult = { song: Song; duplicate: boolean };
type ImportOptions = {
  signal: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  fetcher?: typeof fetch;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  reconnectAttempts?: number;
};
type ImportResponse = {
  jobId?: string;
  status?: "queued" | "processing" | "ready" | "error";
  stage?: "checking" | "downloading" | "detecting-key";
  song?: Song;
  duplicate?: boolean;
  error?: string;
  code?: string;
};

class ImportRequestError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ImportRequestError";
    this.status = status;
  }
}

export function isImportCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function importErrorMessage(error: unknown, fallback = "Não foi possível importar a música."): string {
  if (error instanceof Error && error.message === "UNAUTHORIZED") return "Sua sessão expirou. Entre novamente.";
  if (error instanceof TypeError) return "A conexão foi interrompida. Confira o catálogo antes de tentar novamente.";
  if (error instanceof SyntaxError) return "O servidor enviou uma resposta inválida. Confira o catálogo e tente novamente.";
  return error instanceof Error && error.message ? error.message : fallback;
}

function checkCancellation(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Importação fechada.", "AbortError");
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  checkCancellation(signal);
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer);
      reject(new DOMException("Importação fechada.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancelled);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

function isSong(value: unknown): value is Song {
  return Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string" && "title" in value && typeof value.title === "string");
}

async function requestJson(path: string, init: RequestInit, options: ImportOptions) {
  checkCancellation(options.signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      reject(new DOMException("Importação fechada.", "AbortError"));
    };
    options.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ImportRequestError("O servidor demorou para responder. Confira o catálogo antes de tentar novamente."));
    }, options.requestTimeoutMs ?? 15000);
  });
  try {
    const fetcher = options.fetcher ?? fetch;
    const response = await Promise.race([fetcher(path, { ...init, signal: controller.signal }), interrupted]);
    const data: unknown = await Promise.race([response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    }), interrupted]);
    checkCancellation(options.signal);
    if (!data || typeof data !== "object") {
      if ([401, 403, 404].includes(response.status)) throw responseError(response.status, {});
      throw new ImportRequestError("O servidor não conseguiu responder à importação. Confira o catálogo e tente novamente.", response.status);
    }
    return { response, data: data as ImportResponse & Partial<Song> };
  } catch (error) {
    checkCancellation(options.signal);
    if (timedOut) throw new ImportRequestError("O servidor demorou para responder. Confira o catálogo antes de tentar novamente.");
    if (error instanceof ImportRequestError) throw error;
    throw new ImportRequestError(importErrorMessage(error, "Não foi possível consultar a importação."));
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  }
}

function responseError(status: number, data: ImportResponse): ImportRequestError {
  if (status === 401) return new ImportRequestError("Sua sessão expirou. Entre novamente.", status);
  if (status === 403) return new ImportRequestError("Sua conta não pode acessar esta importação.", status);
  if (status === 404) return new ImportRequestError("Esta importação expirou ou o servidor foi reiniciado. Confira o catálogo e envie o link novamente.", status);
  return new ImportRequestError(typeof data.error === "string" ? data.error : "Não foi possível concluir a importação. Tente novamente.", status);
}

export async function importSong(url: string, actorId: string, options: ImportOptions): Promise<ImportResult> {
  const report = (progress: ImportProgress) => {
    checkCancellation(options.signal);
    options.onProgress?.(progress);
  };
  report({ status: "submitting", message: "Enviando solicitação…" });
  const initial = await requestJson("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.trim(), actorId, asynchronous: true })
  }, options);
  if (initial.response.status === 409 && initial.data.duplicate && isSong(initial.data.song)) return { song: initial.data.song, duplicate: true };
  if (!initial.response.ok) throw responseError(initial.response.status, initial.data);
  if (initial.response.status !== 202 && isSong(initial.data)) return { song: initial.data, duplicate: false };
  if (!initial.data.jobId) throw new ImportRequestError("O servidor não identificou a importação. Confira o catálogo e tente novamente.");

  const path = "/api/import-jobs/" + encodeURIComponent(initial.data.jobId);
  report({ status: "queued", message: "Na fila de processamento…" });
  let reconnects = 0;
  while (true) {
    await wait(options.pollIntervalMs ?? 1500, options.signal);
    let job: ImportResponse;
    try {
      const result = await requestJson(path, { method: "GET", cache: "no-store" }, options);
      if (!result.response.ok) throw responseError(result.response.status, result.data);
      job = result.data;
      reconnects = 0;
    } catch (error) {
      checkCancellation(options.signal);
      const retryable = error instanceof ImportRequestError && (error.status === 0 || error.status >= 500);
      if (!retryable || reconnects >= (options.reconnectAttempts ?? 3)) throw error;
      reconnects += 1;
      report({ status: "reconnecting", message: `Reconectando à importação… tentativa ${reconnects} de ${options.reconnectAttempts ?? 3}` });
      continue;
    }
    checkCancellation(options.signal);
    if (job.status === "ready") {
      if (!isSong(job.song)) throw new ImportRequestError("A importação terminou sem os dados da música. Confira o catálogo.");
      return { song: job.song, duplicate: Boolean(job.duplicate) };
    }
    if (job.status === "error") throw responseError(422, job);
    if (job.status !== "queued" && job.status !== "processing") throw new ImportRequestError("O servidor retornou um estado de importação inválido. Confira o catálogo.");
    const stageMessages = {
      checking: "Verificando o vídeo…",
      downloading: "Baixando e preparando o áudio…",
      "detecting-key": "Identificando o tom da música…"
    };
    report({ status: job.status, message: job.status === "queued" ? "Na fila de processamento…" : (job.stage && stageMessages[job.stage]) || "Preparando a música…" });
  }
}
