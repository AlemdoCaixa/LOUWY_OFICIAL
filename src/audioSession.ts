export type StudioAudioSessionType = "auto" | "playback" | "play-and-record";
type AudioSessionHandle = { type: StudioAudioSessionType };
type ResumableAudioContext = { readonly state: string; resume: () => Promise<void> };

function browserAudioSession(): AudioSessionHandle | undefined {
  if (typeof navigator === "undefined") return;
  return (navigator as Navigator & { audioSession?: AudioSessionHandle }).audioSession;
}

// WebKit otherwise treats Web Audio as ambient and mutes it with the iPhone's silent switch.
// https://bugs.webkit.org/show_bug.cgi?id=237322#c6
export function setAudioSessionType(
  type: StudioAudioSessionType,
  session = browserAudioSession()
): boolean {
  if (!session) return false;
  try {
    session.type = type;
    return session.type === type;
  } catch {
    // This optional API must not prevent playback in other browsers.
    return false;
  }
}

export async function resumeAudioContext(context: ResumableAudioContext, timeoutMs = 4000): Promise<void> {
  if (context.state === "closed") throw new Error("O áudio foi encerrado pelo navegador. Recarregue a página para continuar.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Invoke resume immediately inside the user's click, before any asynchronous work.
    await Promise.race([
      context.resume(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("A ativação do áudio demorou demais.")), timeoutMs);
      })
    ]);
    if (context.state !== "running") throw new Error("O áudio continua interrompido.");
  } catch {
    throw new Error("O navegador não liberou o áudio. Toque em reproduzir para tentar novamente.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
