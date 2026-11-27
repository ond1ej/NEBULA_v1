"""Speech-to-text for Telegram voice messages.

Preference order: local whisper.cpp (audio never leaves the Mac) -> OpenAI transcription API, but ONLY when the owner
explicitly consented in Settings (voice data would be sent to OpenAI). Without either, voice messages are refused
with setup instructions; nothing is uploaded anywhere.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from nebula_host import db

WHISPER_BINS = ("whisper-cli", "whisper-cpp", "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli")
# Official whisper.cpp ggml models (downloaded ONLY when the owner clicks "Download" in Settings → Voice).
MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{name}.bin"
MODELS = {"tiny": 77_691_713, "base": 147_951_465, "small": 487_601_967}  # bytes (multilingual: Czech + English)
_jobs = {"running": 0, "done": 0, "failed": 0}
_sem = None


class STTError(Exception):
    pass


def _whisper(cfg) -> tuple[str | None, Path | None]:
    local_bin = cfg.data_dir / "bin" / "whisper-cli"
    exe = str(local_bin) if local_bin.is_file() else next(
        (shutil.which(b) or (b if Path(b).is_file() else None) for b in WHISPER_BINS
         if shutil.which(b) or Path(b).is_file()), None)
    want = settings().get("model")
    models = sorted((cfg.data_dir / "models").glob("ggml-*.bin")) if (cfg.data_dir / "models").is_dir() else []
    chosen = next((m for m in models if want and m.name == f"ggml-{want}.bin"), models[0] if models else None)
    return exe, chosen


def _openai_key() -> str | None:
    from sqlalchemy import select

    from nebula_host import models
    from nebula_host import secrets as sec

    with db.engine().connect() as c:
        ref = c.execute(select(models.providers.c.keychain_ref).where(models.providers.c.id == "openai-api")).scalar()
    return sec.store().get(ref) if ref else None


def models_status(cfg) -> list[dict[str, Any]]:
    d = cfg.data_dir / "models"
    out = []
    for name, size in MODELS.items():
        p = d / f"ggml-{name}.bin"
        part = d / f"ggml-{name}.bin.part"
        out.append({"name": name, "size_mb": round(size / 1048576), "installed": p.is_file(),
                    "downloading": part.exists(), "downloaded_mb": round(part.stat().st_size / 1048576) if part.exists()
                    else None, "source": MODEL_URL.format(name=name)})
    return out


async def download_model(cfg, name: str) -> dict[str, Any]:
    """Owner-initiated download of an official whisper.cpp model (size + ggml magic verified, then sha256 recorded)."""
    import hashlib

    import httpx

    if name not in MODELS:
        raise STTError(f"unknown model {name!r}")
    d = cfg.data_dir / "models"
    d.mkdir(parents=True, exist_ok=True)
    dest, part = d / f"ggml-{name}.bin", d / f"ggml-{name}.bin.part"
    if dest.is_file():
        return {"name": name, "installed": True, "already": True}
    h = hashlib.sha256()
    n = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120), follow_redirects=True) as c:
        async with c.stream("GET", MODEL_URL.format(name=name)) as r:
            if r.status_code != 200:
                raise STTError(f"download failed: HTTP {r.status_code}")
            with open(part, "wb") as fh:
                async for chunk in r.aiter_bytes(1 << 20):
                    n += len(chunk)
                    if n > MODELS[name] * 1.05:
                        raise STTError("download larger than expected; aborted")
                    h.update(chunk)
                    fh.write(chunk)
    with open(part, "rb") as fh:
        magic = fh.read(4)
    if magic not in (b"lmgg", b"ggml", b"GGUF") or abs(n - MODELS[name]) > MODELS[name] * 0.05:
        part.unlink(missing_ok=True)
        raise STTError("downloaded file is not a whisper.cpp model; deleted")
    part.rename(dest)
    db.set_setting("voice.stt", {**settings(), "model": name, f"sha256_{name}": h.hexdigest()})
    return {"name": name, "installed": True, "bytes": n, "sha256": h.hexdigest()}


def settings() -> dict[str, Any]:
    return {"cloud_consent": False, "cloud_model": "whisper-1", "language": "auto",
            **(db.get_setting("voice.stt", {}) or {})}


def status(cfg) -> dict[str, Any]:
    exe, model = _whisper(cfg)
    s = settings()
    from nebula_host import secrets as sec

    with db.engine().connect() as c:
        from sqlalchemy import select

        from nebula_host import models

        row = c.execute(select(models.providers.c.state, models.providers.c.keychain_ref)
                        .where(models.providers.c.id == "openai-api")).first()
    cloud_ready = bool(row and row.keychain_ref and sec.store().get(row.keychain_ref))
    backend = "whisper_cpp" if exe and model else ("openai" if cloud_ready and s["cloud_consent"] else None)
    return {"backend": backend, "local": {"binary": exe, "model": str(model) if model else None,
                                          "ffmpeg": bool(shutil.which("ffmpeg") or Path("/opt/homebrew/bin/ffmpeg").exists())},
            "cloud": {"provider_connected": cloud_ready, "consent": bool(s["cloud_consent"]), "model": s["cloud_model"]},
            "language": s["language"], "models": models_status(cfg), "jobs": dict(_jobs),
            "local_binary_hint": "brew install whisper-cpp (installs whisper-cli; NEBULA never installs it for you)",
            "setup_hint": None if backend else (
                "Local: install whisper.cpp (brew install whisper-cpp) and put a ggml model (e.g. ggml-base.bin) into "
                f"{cfg.data_dir / 'models'}. Or connect an OpenAI API key and allow cloud transcription in Settings.")}


def _ffmpeg() -> str:
    exe = shutil.which("ffmpeg") or ("/opt/homebrew/bin/ffmpeg" if Path("/opt/homebrew/bin/ffmpeg").exists() else None)
    if not exe:
        raise STTError("ffmpeg is required to decode Telegram voice notes (brew install ffmpeg)")
    return exe


async def transcribe(cfg, data: bytes, filename: str = "voice.ogg", language: str | None = None) -> dict[str, Any]:
    global _sem
    st = status(cfg)
    if st["backend"] is None:
        raise STTError("Voice transcription is not set up. " + (st["setup_hint"] or ""))
    if _sem is None:
        _sem = asyncio.Semaphore(1)  # one model in memory at a time; whisper-cli exits after every job
    async with _sem:
        _jobs["running"] += 1
        try:
            if st["backend"] == "whisper_cpp":
                r = await asyncio.to_thread(_local, cfg, data, filename, language)
            else:
                r = await _cloud(data, filename, language)
            _jobs["done"] += 1
            return r
        except Exception:
            _jobs["failed"] += 1
            raise
        finally:
            _jobs["running"] -= 1


def _local(cfg, data: bytes, filename: str, language: str | None = None) -> dict[str, Any]:
    exe, model = _whisper(cfg)
    with tempfile.TemporaryDirectory(prefix="nebula-stt-") as td:
        src, wav = Path(td) / Path(filename).name, Path(td) / "in.wav"
        src.write_bytes(data)
        subprocess.run([_ffmpeg(), "-nostdin", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", str(wav)],
                       check=True, timeout=120)
        lang = language or settings()["language"]
        if lang not in ("auto", "cs", "en", "de", "sk", "pl", "fr", "es", "it"):
            lang = "auto"
        r = subprocess.run([exe, "-m", str(model), "-f", str(wav), "-l", lang, "-nt", "-otxt", "-of",
                            str(Path(td) / "out")], check=True, timeout=600, capture_output=True, text=True)
        text = (Path(td) / "out.txt").read_text(errors="replace").strip()
    import re as _re

    m = _re.search(r"auto-detected language: (\w+)", r.stderr or "")
    return {"text": text, "backend": "whisper_cpp (local)", "model": Path(str(model)).name,
            "language": m.group(1) if m else (lang if lang != "auto" else None)}


async def _cloud(data: bytes, filename: str, language: str | None = None) -> dict[str, Any]:
    import httpx
    from sqlalchemy import select

    from nebula_host import models
    from nebula_host import secrets as sec

    with db.engine().connect() as c:
        ref = c.execute(select(models.providers.c.keychain_ref).where(models.providers.c.id == "openai-api")).scalar()
    key = sec.store().get(ref) if ref else None
    if not key:
        raise STTError("OpenAI API key not available")
    s = settings()
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post("https://api.openai.com/v1/audio/transcriptions", headers={"Authorization": f"Bearer {key}"},
                         data={"model": s["cloud_model"], **({"language": language} if language in ("cs", "en") else {})},
                         files={"file": (Path(filename).name, data, "audio/ogg")})
    if r.status_code >= 400:
        raise STTError(f"OpenAI transcription failed: HTTP {r.status_code}")
    return {"text": r.json().get("text", "").strip(), "backend": "openai (cloud, consented)", "model": s["cloud_model"],
            "language": language}
