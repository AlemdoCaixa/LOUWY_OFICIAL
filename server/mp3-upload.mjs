import multer from "multer";
import { createReadStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";

export const MAX_MP3_BYTES = 50 * 1024 * 1024;
export const MAX_MP3_SECONDS = 2 * 60 * 60;

export function invalidMp3(message = "O arquivo não contém um áudio MP3 válido.") {
  return Object.assign(new Error(message), { status: 422, code: "INVALID_MP3" });
}

export function createMp3Upload(directory) {
  mkdirSync(directory, { recursive: true });
  // Jobs live in this single API process. Remove abandoned incoming files on
  // startup after a restart; never touch the catalog's published audio.
  for (const name of readdirSync(directory)) {
    if (/^[a-f0-9-]{36}\.mp3$/.test(name)) rmSync(join(directory, name), { force: true });
  }
  return multer({
    storage: multer.diskStorage({
      destination: directory,
      filename(req, _file, callback) {
        const name = randomUUID() + ".mp3";
        req.mp3UploadPath = join(directory, name);
        callback(null, name);
      }
    }),
    limits: { fileSize: MAX_MP3_BYTES, files: 1, fields: 2, fieldSize: 512, parts: 3 },
    fileFilter(_req, file, callback) {
      if (extname(file.originalname).toLowerCase() !== ".mp3") return callback(invalidMp3("Selecione um arquivo MP3."));
      // MIME headers come from the client. Validate the actual media below.
      callback(null, true);
    }
  }).single("audio");
}

export async function hashMp3(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareMp3(input, output, execute) {
  const probe = process.env.FFPROBE_BIN || "ffprobe";
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const inspect = async (path) => {
    const raw = await execute(probe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", path], { timeoutMs: 30000 });
    return JSON.parse(raw);
  };
  let meta;
  try { meta = await inspect(input); }
  catch { throw invalidMp3(); }
  const duration = Number(meta.format?.duration);
  const audio = meta.streams?.filter((stream) => stream.codec_type === "audio") || [];
  if (meta.format?.format_name !== "mp3" || audio.length !== 1 || audio[0].codec_name !== "mp3" || !Number.isFinite(duration) || duration <= 0) throw invalidMp3();
  if (duration > MAX_MP3_SECONDS) throw invalidMp3("O MP3 pode ter no máximo 2 horas de duração.");
  const staged = output + "." + randomUUID() + ".pending.mp3";
  try {
    // Decode the audio, reject corrupt frames, and strip images/metadata before
    // publishing. A renamed video, playlist or MIME header is not enough.
    await execute(ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", input, "-map", "0:a:0", "-vn", "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", "192k", "-threads", "1", "-t", String(MAX_MP3_SECONDS), "-y", staged], { timeoutMs: 5 * 60 * 1000 });
    const prepared = await inspect(staged);
    const actualDuration = Number(prepared.format?.duration);
    if (!Number.isFinite(actualDuration) || actualDuration <= 0) throw invalidMp3();
    await rename(staged, output);
    return { duration: actualDuration, tags: meta.format?.tags || {} };
  } catch (error) {
    if (error.code === "INVALID_MP3" || /tempo limite/.test(error.message)) throw error;
    throw invalidMp3("Não foi possível ler o MP3. O arquivo pode estar incompleto ou corrompido.");
  } finally {
    rmSync(staged, { force: true });
  }
}
