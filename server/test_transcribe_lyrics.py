"""Model-free tests for the transcription adapter; no database or downloads."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name("transcribe_lyrics.py")
SPEC = importlib.util.spec_from_file_location("transcribe_lyrics", SCRIPT)
lyrics = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lyrics)


class TranscriptionTests(unittest.TestCase):
    def test_linux_uses_cpu_int8_and_preserves_word_timestamps(self):
        model = Mock()
        model.transcribe.return_value = (
            iter([
                SimpleNamespace(text=" ", start=0, end=0.5, words=None),
                SimpleNamespace(text=" Santo Senhor ", start=0.55555, end=2.34567, words=[
                    SimpleNamespace(word=" Santo", start=0.55555, end=1.23456),
                    SimpleNamespace(word=" Senhor", start=1.23456, end=2.34567),
                ]),
                SimpleNamespace(text=" Amém ", start=3, end=4, words=None),
            ]),
            SimpleNamespace(language="pt"),
        )
        constructor = Mock(return_value=model)
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(lyrics.platform, "system", return_value="Linux"), \
                patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=constructor)}):
            result = lyrics.transcribe("sample.mp3")
        self.assertEqual(constructor.call_args.args, ("small",))
        self.assertEqual(constructor.call_args.kwargs["device"], "cpu")
        self.assertEqual(constructor.call_args.kwargs["compute_type"], "int8")
        self.assertEqual(constructor.call_args.kwargs["cpu_threads"], 2)
        self.assertTrue(model.transcribe.call_args.kwargs["word_timestamps"])
        self.assertEqual(result["language"], "pt")
        self.assertEqual(result["model"], "faster-whisper/small")
        self.assertEqual(result["text"], "Santo Senhor Amém")
        self.assertEqual(result["lines"][0], {
            "text": "Santo Senhor", "time": 0.556, "end": 2.346,
            "words": [
                {"text": "Santo", "start": 0.556, "end": 1.235},
                {"text": "Senhor", "start": 1.235, "end": 2.346},
            ],
        })
        self.assertEqual(result["lines"][1]["words"], [])

    def test_cpu_model_cache_and_thread_configuration(self):
        model = Mock()
        model.transcribe.return_value = (iter([]), SimpleNamespace(language=""))
        constructor = Mock(return_value=model)
        with patch.dict(os.environ, {
            "LYRICS_BACKEND": "faster-whisper", "LYRICS_MODEL": "/models/custom",
            "LYRICS_MODEL_DIR": "/cache/whisper", "LYRICS_CPU_THREADS": "4",
        }, clear=True), patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=constructor)}):
            result = lyrics.transcribe("sample.mp3")
        self.assertEqual(constructor.call_args.args, ("/models/custom",))
        self.assertEqual(constructor.call_args.kwargs["download_root"], "/cache/whisper")
        self.assertEqual(constructor.call_args.kwargs["cpu_threads"], 4)
        self.assertEqual(result["lines"], [])

    def test_apple_silicon_retains_mlx_backend_and_shape(self):
        transcribe = Mock(return_value={
            "language": "pt", "text": " Santo ",
            "segments": [{"text": " Santo ", "start": 1.11111, "end": 2.22222,
                          "words": [{"word": " Santo", "start": 1.11111, "end": 2.22222}]}],
        })
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(lyrics.platform, "system", return_value="Darwin"), \
                patch.object(lyrics.platform, "machine", return_value="arm64"), \
                patch.dict(sys.modules, {"mlx_whisper": SimpleNamespace(transcribe=transcribe)}):
            result = lyrics.transcribe("sample.mp3")
        self.assertEqual(transcribe.call_args.kwargs["path_or_hf_repo"], lyrics.MLX_MODEL)
        self.assertEqual(result["text"], "Santo")
        self.assertEqual(result["lines"][0]["words"][0], {"text": "Santo", "start": 1.111, "end": 2.222})

    def test_intel_mac_uses_cpu_backend(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(lyrics.platform, "system", return_value="Darwin"), \
                patch.object(lyrics.platform, "machine", return_value="x86_64"), \
                patch.object(lyrics, "transcribe_cpu", return_value={"ok": True}) as cpu:
            self.assertEqual(lyrics.transcribe("sample.mp3"), {"ok": True})
        cpu.assert_called_once_with("sample.mp3", "small")

    def test_invalid_backend_has_clear_error(self):
        with patch.dict(os.environ, {"LYRICS_BACKEND": "unknown"}, clear=True):
            with self.assertRaisesRegex(ValueError, "LYRICS_BACKEND"):
                lyrics.transcribe("sample.mp3")

    def test_cli_errors_are_json_without_model_import(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("caminho", json.loads(result.stdout)["error"])
        self.assertEqual(result.stderr, "")

    def test_cli_invalid_backend_is_caught(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "unused.mp3"], text=True, capture_output=True,
            env={**os.environ, "LYRICS_BACKEND": "unknown"}, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("LYRICS_BACKEND", json.loads(result.stdout)["error"])
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
