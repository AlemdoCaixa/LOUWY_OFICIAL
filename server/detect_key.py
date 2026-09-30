import json
import sys

import librosa
import numpy as np

KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=float)
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=float)

def corr(a, b):
    a = (a - a.mean()) / (a.std() + 1e-9)
    b = (b - b.mean()) / (b.std() + 1e-9)
    return float(np.dot(a, b) / len(a))

def detect(path):
    y, sr = librosa.load(path, sr=11025, mono=True, duration=240)
    if len(y) < sr * 3:
        raise ValueError("audio muito curto")

    if len(y) > sr * 12:
        y = y[sr * 8:]

    chroma = librosa.feature.chroma_stft(
        y=y, sr=sr, n_fft=4096, hop_length=2048
    )
    energy = np.median(chroma, axis=1)
    energy = energy / (energy.sum() + 1e-9)

    scores = []
    for tonic in range(12):
        scores.append((corr(energy, np.roll(MAJOR, tonic)), tonic, "major"))
        scores.append((corr(energy, np.roll(MINOR, tonic)), tonic, "minor"))

    scores.sort(reverse=True)
    best, second = scores[0], scores[1]
    gap = max(0.0, best[0] - second[0])
    confidence = int(max(40, min(98, 58 + gap * 160)))

    return {
        "key": KEYS[best[1]],
        "mode": best[2],
        "confidence": confidence,
        "score": round(best[0], 4),
        "second": {"key": KEYS[second[1]], "mode": second[2], "score": round(second[0], 4)}
    }

if __name__ == "__main__":
    try:
        print(json.dumps(detect(sys.argv[1]), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
