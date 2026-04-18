#!/usr/bin/env python3
"""
Local realtime Faster-Whisper pipeline.

- STT only (translation is handled by text_translate.py)
- GPU-first runtime with CPU fallback
- Emits provisional + finalized utterances as JSON lines
"""

import argparse
import json
import os
from pathlib import Path
import sys
import threading
import time

import numpy as np

os.environ["TOKENIZERS_PARALLELISM"] = "false"

def _try_reconfigure_stream(stream: object) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8", errors="replace")


_try_reconfigure_stream(sys.stdout)
_try_reconfigure_stream(sys.stderr)


def emit(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def log(message):
    print(f"[pipeline] {message}", file=sys.stderr, flush=True)


def configure_windows_cuda_runtime():
    if sys.platform != "win32":
        return []

    python_dir = Path(sys.executable).resolve().parent
    env_dir = python_dir.parent
    site_packages = env_dir / "Lib" / "site-packages"
    candidate_dirs = [
        site_packages / "nvidia" / "cublas" / "bin",
        site_packages / "nvidia" / "cuda_runtime" / "bin",
        site_packages / "nvidia" / "cuda_nvrtc" / "bin",
        site_packages / "nvidia" / "cudnn" / "bin",
    ]

    added = []
    for candidate in candidate_dirs:
        if not candidate.exists():
            continue
        candidate_str = str(candidate)
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(candidate_str)
            except OSError:
                pass
        added.append(candidate_str)

    if added:
        existing_path = os.environ.get("PATH", "")
        path_entries = [entry for entry in existing_path.split(os.pathsep) if entry]
        new_entries = [entry for entry in added if entry not in path_entries]
        if new_entries:
            os.environ["PATH"] = os.pathsep.join(new_entries + path_entries)

    return added


CUDA_DLL_DIRS = configure_windows_cuda_runtime()


def normalize_model_name(model_name: str) -> str:
    normalized = (model_name or "turbo").strip().lower()
    if normalized in {"large-v3", "large_v3", "large"}:
        return "large-v3"
    return "turbo"


WHISPER_MODEL_IDS = {
    "turbo": "turbo",
    "large-v3": "large-v3",
}


def normalize_lang(lang_code: str | None) -> str | None:
    if not lang_code:
        return None
    code = lang_code.lower()
    if code.startswith("zh"):
        return "zh"
    return code.split("-")[0]


class RealtimeLocalPipeline:
    def __init__(
        self,
        source_lang: str = "auto",
        target_lang: str = "vi",
        model_name: str = "turbo",
        initial_prompt: str | None = None,
        hotwords: list[str] | None = None,
    ):
        self.source_lang = source_lang
        self.target_lang = target_lang
        self.requested_model = normalize_model_name(model_name)
        self.initial_prompt = (initial_prompt or "").strip() or None
        self.hotwords = [word.strip() for word in (hotwords or []) if word and word.strip()]
        self.hotwords_value = ", ".join(self.hotwords) if self.hotwords else None

        self.sample_rate = 16000
        self.bytes_per_sample = 2
        self.frame_ms = 100
        self.frame_bytes = int(self.sample_rate * self.bytes_per_sample * (self.frame_ms / 1000))
        self.preview_interval_sec = 0.85
        self.min_preview_audio_sec = 0.8
        self.finalize_silence_frames = 10
        self.max_utterance_sec = 10.0
        self.rms_threshold = 140.0
        self.decode_beam_size = 3
        self.decode_best_of = 3
        self.condition_on_previous_text = True

        self.lock = threading.Lock()
        self.input_buffer = bytearray()
        self.current_audio = bytearray()
        self.running = True

        self.active_utterance_id = None
        self.active_revision = 0
        self.utterance_counter = 0
        self.silence_frames = 0
        self.last_preview_at = 0.0
        self.last_provisional_text = ""
        self.detected_language = normalize_lang(source_lang) if source_lang != "auto" else None
        self.actual_model = None
        self.actual_device = None
        self.actual_compute_type = None

        self._load_model()

    def _emit_ready(self):
        emit({
            "type": "ready",
            "model": self.actual_model,
            "device": self.actual_device,
            "compute_type": self.actual_compute_type,
        })

    def _reload_model(self, model_name: str, device: str, compute_type: str):
        from faster_whisper import WhisperModel

        emit({
            "type": "status",
            "message": f"Switching model={model_name} device={device} compute={compute_type}...",
        })
        self.whisper_model = WhisperModel(WHISPER_MODEL_IDS[model_name], device=device, compute_type=compute_type)
        self.actual_model = model_name
        self.actual_device = device
        self.actual_compute_type = compute_type
        self._emit_ready()

    def _maybe_recover_runtime_failure(self, exc: Exception) -> bool:
        if self.actual_device != "cuda":
            return False

        message = str(exc).lower()
        recoverable_tokens = ("cublas", "cudnn", "cuda", "cublas64_12.dll")
        if not any(token in message for token in recoverable_tokens):
            return False

        log(f"runtime cuda failure detected, falling back to cpu turbo: {exc}")
        emit({
            "type": "status",
            "message": "CUDA runtime is unavailable. Falling back to Turbo on CPU.",
        })
        self._reload_model("turbo", "cpu", "int8")
        return True

    def _load_model(self):
        emit({"type": "status", "message": f"Loading Faster-Whisper {self.requested_model}..."})
        start = time.time()

        try:
            import ctranslate2
            from faster_whisper import WhisperModel
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "Faster-Whisper Realtime is not installed yet. Finish local setup first."
            ) from exc

        try:
            has_cuda = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            has_cuda = False

        candidates: list[tuple[str, str, str]] = []
        if has_cuda:
            if self.requested_model == "large-v3":
                candidates.extend(
                    [
                        ("large-v3", "cuda", "int8_float16"),
                        ("turbo", "cuda", "float16"),
                        ("turbo", "cpu", "int8"),
                    ]
                )
            else:
                candidates.extend(
                    [
                        ("turbo", "cuda", "float16"),
                        ("turbo", "cpu", "int8"),
                    ]
                )
        else:
            if self.requested_model == "large-v3":
                emit({
                    "type": "status",
                    "message": "Large-v3 is not suitable for realtime without CUDA. Falling back to Turbo on CPU.",
                })
                candidates.append(("turbo", "cpu", "int8"))
            else:
                candidates.append(("turbo", "cpu", "int8"))

        last_error = None
        for model_name, device, compute_type in candidates:
            try:
                emit({
                    "type": "status",
                    "message": f"Loading model={model_name} device={device} compute={compute_type}...",
                })
                self.whisper_model = WhisperModel(
                    WHISPER_MODEL_IDS[model_name],
                    device=device,
                    compute_type=compute_type,
                )
                self.actual_model = model_name
                self.actual_device = device
                self.actual_compute_type = compute_type
                break
            except Exception as exc:  # pragma: no cover - runtime dependent
                last_error = exc
                log(f"model load failed model={model_name} device={device} compute={compute_type}: {exc}")

        if not getattr(self, "whisper_model", None):
            raise RuntimeError(f"Failed to load Faster-Whisper model: {last_error}")

        log(
            f"Faster-Whisper loaded in {time.time() - start:.1f}s "
            f"model={self.actual_model} device={self.actual_device} compute={self.actual_compute_type}"
        )
        if CUDA_DLL_DIRS:
            log(f"windows cuda dll dirs configured: {CUDA_DLL_DIRS}")
        self._emit_ready()

    def _start_utterance(self):
        if self.active_utterance_id is not None:
            return
        self.utterance_counter += 1
        self.active_utterance_id = f"fw-{self.utterance_counter}"
        self.active_revision = 0
        self.current_audio = bytearray()
        self.last_provisional_text = ""
        self.silence_frames = 0
        self.last_preview_at = 0.0

    def _reset_utterance(self):
        self.active_utterance_id = None
        self.active_revision = 0
        self.current_audio = bytearray()
        self.last_provisional_text = ""
        self.silence_frames = 0
        self.last_preview_at = 0.0

    def _transcribe_pcm(self, pcm_bytes: bytes):
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        forced_lang = None if self.source_lang == "auto" else normalize_lang(self.source_lang)

        def run_transcribe():
            return self.whisper_model.transcribe(
                audio,
                language=forced_lang,
                task="transcribe",
                beam_size=self.decode_beam_size,
                best_of=self.decode_best_of,
                vad_filter=True,
                condition_on_previous_text=self.condition_on_previous_text,
                initial_prompt=self.initial_prompt,
                hotwords=self.hotwords_value,
            )

        try:
            segments, info = run_transcribe()
        except Exception as exc:
            if not self._maybe_recover_runtime_failure(exc):
                raise
            segments, info = run_transcribe()
        text = " ".join(segment.text.strip() for segment in segments).strip()
        detected = normalize_lang(getattr(info, "language", None) or forced_lang or "auto")
        return text, detected

    def _emit_provisional(self, text: str, language: str | None):
        if not text or text == self.last_provisional_text or not self.active_utterance_id:
            return
        self.active_revision += 1
        self.last_provisional_text = text
        self.detected_language = language or self.detected_language
        emit(
            {
                "type": "provisional",
                "utterance_id": self.active_utterance_id,
                "revision": self.active_revision,
                "text": text,
                "language": self.detected_language,
            }
        )

    def _emit_final(self, text: str, language: str | None):
        if not text or not self.active_utterance_id:
            self._reset_utterance()
            return
        self.active_revision += 1
        self.detected_language = language or self.detected_language
        emit(
            {
                "type": "original",
                "utterance_id": self.active_utterance_id,
                "revision": self.active_revision,
                "text": text,
                "language": self.detected_language,
                "speech_final": True,
                "model": self.actual_model,
            }
        )
        self._reset_utterance()

    def _consume_frame(self, frame: bytes):
        samples = np.frombuffer(frame, dtype=np.int16)
        if samples.size == 0:
            return

        rms = float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)))
        is_speech = rms >= self.rms_threshold

        if is_speech:
            self._start_utterance()
            self.current_audio.extend(frame)
            self.silence_frames = 0
        elif self.active_utterance_id is not None:
            self.current_audio.extend(frame)
            self.silence_frames += 1

        if self.active_utterance_id is None:
            return

        audio_duration = len(self.current_audio) / (self.sample_rate * self.bytes_per_sample)
        now = time.time()
        if audio_duration >= self.min_preview_audio_sec and (now - self.last_preview_at) >= self.preview_interval_sec:
            try:
                text, language = self._transcribe_pcm(bytes(self.current_audio))
                self._emit_provisional(text, language)
            except Exception as exc:
                emit({"type": "error", "message": str(exc)})
                log(f"preview transcription error: {exc}")
            self.last_preview_at = now

        should_finalize = self.silence_frames >= self.finalize_silence_frames or audio_duration >= self.max_utterance_sec
        if should_finalize:
            try:
                text, language = self._transcribe_pcm(bytes(self.current_audio))
                self._emit_final(text, language)
            except Exception as exc:
                emit({"type": "error", "message": str(exc)})
                log(f"final transcription error: {exc}")
                self._reset_utterance()

    def _finalize_remaining(self):
        if self.active_utterance_id is None or len(self.current_audio) < self.frame_bytes:
            return
        try:
            text, language = self._transcribe_pcm(bytes(self.current_audio))
            self._emit_final(text, language)
        except Exception as exc:
            emit({"type": "error", "message": str(exc)})
            log(f"flush transcription error: {exc}")
            self._reset_utterance()

    def stdin_reader(self):
        try:
            while self.running:
                data = sys.stdin.buffer.read(4096)
                if not data:
                    break
                with self.lock:
                    self.input_buffer.extend(data)
        except Exception as exc:
            log(f"stdin reader error: {exc}")
        finally:
            self.running = False

    def run(self):
        reader = threading.Thread(target=self.stdin_reader, daemon=True)
        reader.start()

        while self.running:
            time.sleep(0.05)
            frames = []
            with self.lock:
                while len(self.input_buffer) >= self.frame_bytes:
                    frames.append(bytes(self.input_buffer[: self.frame_bytes]))
                    del self.input_buffer[: self.frame_bytes]

            for frame in frames:
                self._consume_frame(frame)

        with self.lock:
            trailing = bytes(self.input_buffer)
            self.input_buffer.clear()
        if trailing:
            self.current_audio.extend(trailing)
        self._finalize_remaining()

        emit({"type": "done"})
        log("Pipeline stopped.")


def parse_hotwords(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part and part.strip()]


def main():
    parser = argparse.ArgumentParser(description="Faster-Whisper realtime local pipeline")
    parser.add_argument("--source-lang", default="auto")
    parser.add_argument("--target-lang", default="vi")
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--initial-prompt", default="")
    parser.add_argument("--hotwords", default="")
    args = parser.parse_args()

    try:
        pipeline = RealtimeLocalPipeline(
            source_lang=args.source_lang,
            target_lang=args.target_lang,
            model_name=args.model,
            initial_prompt=args.initial_prompt,
            hotwords=parse_hotwords(args.hotwords),
        )
        pipeline.run()
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        log(f"startup error: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
