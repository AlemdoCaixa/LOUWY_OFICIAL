import json
import os
import platform
import sys
from contextlib import redirect_stdout
from pathlib import Path

MLX_MODEL = "mlx-community/whisper-large-v3-turbo-q4"
CPU_MODEL = "small"

def clean_words(words):
    output = []
    for word in words or []:
        text = str(word.get("word", "")).strip()
        if not text:
            continue
        output.append({
            "text": text,
            "start": round(float(word.get("start", 0)), 3),
            "end": round(float(word.get("end", word.get("start", 0))), 3),
        })
    return output

def transcribe_mlx(path, model):
    import mlx_whisper

    result = mlx_whisper.transcribe(
        path,
        path_or_hf_repo=model,
        task="transcribe",
        word_timestamps=True,
        verbose=None,
        temperature=0.0,
        condition_on_previous_text=False,
        hallucination_silence_threshold=1.5,
    )
    lines = []
    for segment in result.get("segments", []):
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        lines.append({
            "text": text,
            "time": round(float(segment.get("start", 0)), 3),
            "end": round(float(segment.get("end", segment.get("start", 0))), 3),
            "words": clean_words(segment.get("words", [])),
        })
    return {
        "language": result.get("language", "pt"),
        "text": str(result.get("text", "")).strip(),
        "lines": lines,
        "model": model,
    }


def transcribe_cpu(path, model):
    from faster_whisper import WhisperModel

    cache = os.environ.get("LYRICS_MODEL_DIR") or str(Path(__file__).parent / "models" / "whisper")
    threads = max(1, int(os.environ.get("LYRICS_CPU_THREADS", "2")))
    recognizer = WhisperModel(
        model,
        device="cpu",
        compute_type="int8",
        cpu_threads=threads,
        num_workers=1,
        download_root=cache,
    )
    segments, info = recognizer.transcribe(
        path,
        task="transcribe",
        word_timestamps=True,
        temperature=0.0,
        condition_on_previous_text=False,
        hallucination_silence_threshold=1.5,
    )
    lines = []
    for segment in segments:
        text = str(segment.text).strip()
        if not text:
            continue
        lines.append({
            "text": text,
            "time": round(float(segment.start), 3),
            "end": round(float(segment.end), 3),
            "words": clean_words([
                {"word": word.word, "start": word.start, "end": word.end}
                for word in (segment.words or [])
            ]),
        })
    return {
        "language": info.language or "pt",
        "text": " ".join(line["text"] for line in lines),
        "lines": lines,
        "model": "faster-whisper/" + model,
    }


def transcribe(path):
    backend = os.environ.get("LYRICS_BACKEND", "auto").strip().lower()
    if backend == "auto":
        backend = "mlx" if platform.system() == "Darwin" and platform.machine() == "arm64" else "faster-whisper"
    if backend == "mlx":
        return transcribe_mlx(path, os.environ.get("LYRICS_MODEL") or MLX_MODEL)
    if backend == "faster-whisper":
        return transcribe_cpu(path, os.environ.get("LYRICS_MODEL") or CPU_MODEL)
    raise ValueError("LYRICS_BACKEND deve ser auto, mlx ou faster-whisper")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Informe o caminho do áudio para transcrição")
        # Keep stdout machine-readable even if a model library prints progress.
        with redirect_stdout(sys.stderr):
            result = transcribe(sys.argv[1])
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
