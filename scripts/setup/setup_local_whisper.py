#!/usr/bin/env python3
"""
Setup for local Faster-Whisper realtime.

- Creates a Python venv
- Installs Faster-Whisper + local translation dependencies
- Preloads Turbo by default
- Downloads Large-v3 on demand when selected
- Pins NLLB-200 distilled-600M for translation
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


SETUP_VERSION = 4
DEFAULT_MODEL = "turbo"
SUPPORTED_MODELS = {"turbo", "large-v3"}
WHISPER_MODEL_IDS = {
    "turbo": "turbo",
    "large-v3": "large-v3",
}
BASE_TRANSLATION_MODELS = [
    "facebook/nllb-200-distilled-600M",
    "Helsinki-NLP/opus-mt-vi-en",
    "Helsinki-NLP/opus-mt-en-vi",
]
TRANSLATION_MODEL_ALIASES = {
    "marian": None,
    "nllb_600m": "facebook/nllb-200-distilled-600M",
    "azure": None,
}


def emit(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def default_env_dir():
    custom = os.environ.get("MY_TRANSLATOR_ENV_DIR")
    if custom:
        return Path(custom)

    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "My Translator" / "local-env"


def venv_python(env_dir: Path) -> Path:
    return env_dir / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python3")


def marker_path(env_dir: Path) -> Path:
    return env_dir / ".setup_complete"


def run(cmd, timeout=600):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def parse_python_version(version_text):
    parts = version_text.split(".")
    return int(parts[0]), int(parts[1]), int(parts[2]) if len(parts) > 2 else 0


def is_supported_python(major, minor):
    return major == 3 and minor in (10, 11, 12)


def normalize_model_name(model_name: str) -> str:
    normalized = (model_name or DEFAULT_MODEL).strip().lower()
    if normalized in {"large-v3", "large_v3", "large"}:
        return "large-v3"
    return DEFAULT_MODEL if normalized not in SUPPORTED_MODELS else normalized


def normalize_translation_model(model_name: str | None) -> str:
    normalized = (model_name or "nllb_600m").strip().lower().replace("-", "_")
    return normalized if normalized in TRANSLATION_MODEL_ALIASES else "nllb_600m"


def translation_model_name(selected_translation_model: str) -> str | None:
    return TRANSLATION_MODEL_ALIASES.get(normalize_translation_model(selected_translation_model))


def load_marker(env_dir: Path) -> dict:
    marker = marker_path(env_dir)
    if not marker.exists():
        return {}
    try:
        return json.loads(marker.read_text(encoding="utf-8"))
    except Exception:
        return {}


def is_setup_complete(env_dir: Path) -> bool:
    python = venv_python(env_dir)
    if not python.exists():
        return False
    data = load_marker(env_dir)
    if not data:
        return False
    downloaded = data.get("downloaded_whisper_models") or []
    return (
        data.get("version") == SETUP_VERSION
        and DEFAULT_MODEL in downloaded
        and "facebook/nllb-200-distilled-600M" in (data.get("translation_models") or [])
    )


def check_system_python():
    candidates = []
    seen_versions = []

    if sys.platform == "win32":
        candidates.extend([
            ["py", "-3.12"],
            ["py", "-3.11"],
            ["py", "-3.10"],
            ["python"],
        ])
    else:
        for path in ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]:
            if os.path.exists(path):
                candidates.append([path])
        candidates.extend([["python3"], ["python"]])

    for cmd in candidates:
        try:
            result = run(cmd + ["--version"], timeout=10)
        except Exception:
            continue
        version_text = (result.stdout or result.stderr).strip()
        if result.returncode != 0 or not version_text.startswith("Python"):
            continue
        version = version_text.split()[-1]
        major, minor, _ = parse_python_version(version)
        seen_versions.append(version)
        if is_supported_python(major, minor):
            return cmd, version

    if seen_versions:
        return None, f"unsupported:{', '.join(dict.fromkeys(seen_versions))}"
    return None, None


def friendly_python_error(found_versions):
    if found_versions and found_versions.startswith("unsupported:"):
        versions = found_versions.split(":", 1)[1]
        return (
            "Faster-Whisper Realtime currently supports Python 3.10, 3.11, or 3.12. "
            f"Found unsupported version(s): {versions}. "
            "Install Python 3.11 or 3.12, then run setup again."
        )
    return (
        "Python 3.10, 3.11, or 3.12 not found. "
        "Install a supported Python version and ensure it is available in PATH."
    )


def _handle_remove_readonly(func, path, exc_info):
    try:
        os.chmod(path, 0o700)
        func(path)
    except Exception:
        raise exc_info[1]


def reset_env_dir(env_dir: Path):
    if not env_dir.exists():
        return

    last_error = None
    for _ in range(5):
        try:
            tombstone = env_dir.with_name(f"{env_dir.name}.deleting-{int(time.time() * 1000)}")
            try:
                env_dir.rename(tombstone)
            except Exception:
                tombstone = env_dir
            shutil.rmtree(tombstone, onerror=_handle_remove_readonly)
            return
        except Exception as exc:
            last_error = exc
            time.sleep(1)

    raise RuntimeError(
        "Failed to clear old local environment. "
        f"Close other My Translator windows or Python processes using '{env_dir}', "
        "then delete the folder and run setup again. "
        f"Last error: {last_error}"
    )


def create_venv(python_cmd, env_dir: Path):
    emit({"type": "progress", "step": "venv", "message": "Creating Python environment..."})
    env_dir.parent.mkdir(parents=True, exist_ok=True)
    reset_env_dir(env_dir)
    result = run(python_cmd + ["-m", "venv", str(env_dir)], timeout=180)
    if result.returncode != 0:
        raise RuntimeError(f"Failed to create venv: {result.stderr[:400]}")

    python_path = str(venv_python(env_dir))
    upgrade = run([python_path, "-m", "pip", "install", "--upgrade", "pip"], timeout=300)
    if upgrade.returncode != 0:
        raise RuntimeError(f"Failed to upgrade pip: {upgrade.stderr[:400]}")

    emit({"type": "progress", "step": "venv", "message": "Python environment created", "done": True})


def install_packages(env_dir: Path):
    python_path = str(venv_python(env_dir))
    packages = [
        ("numpy", "Audio array processing"),
        ("faster-whisper", "Realtime local speech-to-text"),
        ("torch", "Local NLLB translation runtime"),
        ("transformers", "NLLB translation runtime"),
        ("sentencepiece", "Tokenizer support"),
        ("sacremoses", "Tokenizer utilities"),
    ]
    if sys.platform == "win32":
        packages.extend([
            ("nvidia-cuda-runtime-cu12", "CUDA runtime DLLs for Faster-Whisper"),
            ("nvidia-cuda-nvrtc-cu12", "CUDA NVRTC runtime for Faster-Whisper"),
            ("nvidia-cublas-cu12", "cuBLAS DLLs for Faster-Whisper"),
            ("nvidia-cudnn-cu12", "cuDNN DLLs for Faster-Whisper"),
        ])

    for i, (pkg, desc) in enumerate(packages):
        emit({
            "type": "progress",
            "step": "packages",
            "message": f"Installing {pkg} ({i + 1}/{len(packages)})... {desc}",
            "progress": (i / len(packages)) * 100,
        })
        result = run([python_path, "-m", "pip", "install", pkg], timeout=1800)
        if result.returncode != 0:
            raise RuntimeError(f"Failed to install {pkg}: {result.stderr[:500]}")

    emit({
        "type": "progress",
        "step": "packages",
        "message": "All packages installed",
        "progress": 100,
        "done": True,
    })


def download_whisper_model(env_dir: Path, model_name: str):
    python_path = str(venv_python(env_dir))
    model_id = WHISPER_MODEL_IDS[model_name]
    code = f"""
from faster_whisper import WhisperModel
WhisperModel("{model_id}", device="cpu", compute_type="int8")
print("OK", flush=True)
"""
    result = run([python_path, "-c", code], timeout=3600)
    if result.returncode != 0:
        raise RuntimeError(f"Failed to download Faster-Whisper model {model_name}: {result.stderr[:500]}")


def download_translation_model(env_dir: Path, model_name: str):
    python_path = str(venv_python(env_dir))
    code = f"""
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
AutoTokenizer.from_pretrained("{model_name}")
AutoModelForSeq2SeqLM.from_pretrained("{model_name}")
print("OK", flush=True)
"""
    result = run([python_path, "-c", code], timeout=5400)
    if result.returncode != 0:
        raise RuntimeError(f"Failed to download translation model {model_name}: {result.stderr[:500]}")


def desired_translation_models(selected_translation_model: str) -> list[str]:
    models = list(BASE_TRANSLATION_MODELS)
    extra = translation_model_name(selected_translation_model)
    if extra and extra not in models:
        models.append(extra)
    return models


def download_models(
    env_dir: Path,
    selected_model: str,
    selected_translation_model: str,
    existing_marker: dict,
):
    desired_whisper_models = [DEFAULT_MODEL]
    if selected_model == "large-v3":
        desired_whisper_models.append(selected_model)

    existing_whisper_models = set(existing_marker.get("downloaded_whisper_models") or [])
    existing_translation_models = set(existing_marker.get("translation_models") or [])

    missing_whisper_models = [model for model in desired_whisper_models if model not in existing_whisper_models]
    missing_translation_models = [
        model for model in desired_translation_models(selected_translation_model)
        if model not in existing_translation_models
    ]

    total_steps = len(missing_whisper_models) + len(missing_translation_models)
    if total_steps == 0:
        emit({
            "type": "progress",
            "step": "models",
            "message": "All requested Faster-Whisper and translation models are already downloaded",
            "progress": 100,
            "done": True,
        })
        return sorted(existing_whisper_models), sorted(existing_translation_models)

    step_index = 0
    for model_name in missing_whisper_models:
        step_index += 1
        emit({
            "type": "progress",
            "step": "models",
            "message": f"Downloading Faster-Whisper model {model_name} ({step_index}/{total_steps})...",
            "progress": (step_index / total_steps) * 100,
        })
        download_whisper_model(env_dir, model_name)
        existing_whisper_models.add(model_name)

    for model_name in missing_translation_models:
        step_index += 1
        emit({
            "type": "progress",
            "step": "models",
            "message": f"Downloading translation model {model_name} ({step_index}/{total_steps})...",
            "progress": (step_index / total_steps) * 100,
        })
        download_translation_model(env_dir, model_name)
        existing_translation_models.add(model_name)

    emit({
        "type": "progress",
        "step": "models",
        "message": "Faster-Whisper and translation models downloaded",
        "progress": 100,
        "done": True,
    })
    return sorted(existing_whisper_models), sorted(existing_translation_models)


def write_marker(env_dir: Path, selected_model: str, downloaded_whisper_models: list[str], translation_models: list[str]):
    marker_path(env_dir).write_text(json.dumps({
        "version": SETUP_VERSION,
        "backend": "faster-whisper-realtime",
        "python": str(venv_python(env_dir)),
        "default_model": DEFAULT_MODEL,
        "selected_model": selected_model,
        "downloaded_whisper_models": downloaded_whisper_models,
        "translation_models": translation_models,
    }, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Faster-Whisper Realtime setup")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--translation-model", default="nllb_600m")
    args = parser.parse_args()

    selected_model = normalize_model_name(args.model)
    selected_translation_model = normalize_translation_model(args.translation_model)
    env_dir = default_env_dir()

    if args.check:
        ready = is_setup_complete(env_dir)
        emit({"type": "check", "ready": ready, "env_dir": str(env_dir)})
        sys.exit(0 if ready else 1)

    emit({"type": "start", "message": "Starting Faster-Whisper Realtime setup...", "env_dir": str(env_dir)})

    try:
        python_cmd, version = check_system_python()
        if not python_cmd:
            raise RuntimeError(friendly_python_error(version))

        emit({
            "type": "progress",
            "step": "check",
            "message": f"Found Python {version}",
            "done": True,
        })
        emit({
            "type": "log",
            "message": f"Using Python {version} at {' '.join(python_cmd)}",
        })

        marker = load_marker(env_dir)
        current_python = venv_python(env_dir)
        can_reuse_env = marker.get("version") == SETUP_VERSION and current_python.exists()

        if can_reuse_env:
            emit({
                "type": "progress",
                "step": "venv",
                "message": "Reusing existing Faster-Whisper environment",
                "done": True,
            })
            emit({
                "type": "progress",
                "step": "packages",
                "message": "Packages already installed",
                "progress": 100,
                "done": True,
            })
        else:
            create_venv(python_cmd, env_dir)
            install_packages(env_dir)
            marker = {}

        downloaded_whisper_models, translation_models = download_models(
            env_dir,
            selected_model,
            selected_translation_model,
            marker,
        )
        write_marker(env_dir, selected_model, downloaded_whisper_models, translation_models)

        emit({
            "type": "complete",
            "message": "Faster-Whisper Realtime setup complete! Ready to translate.",
            "python": str(venv_python(env_dir)),
            "env_dir": str(env_dir),
            "model": selected_model,
            "downloaded_whisper_models": downloaded_whisper_models,
        })
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
