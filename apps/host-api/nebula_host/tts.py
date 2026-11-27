"""Text-to-speech for voice replies (V3 Voice Agent 2.0).

Providers
  macos   local, built-in `say` (Czech "Zuzana", English voices, …) -> OGG/Opus via ffmpeg (Telegram voice note);
          free, no network. Falls back to M4A via afconvert when ffmpeg is missing (Telegram accepts M4A voice).
  openai  optional cloud TTS; only with a connected OpenAI API key AND explicit owner consent (text is sent to OpenAI).

Synthesis is queued (one job at a time) and nothing stays loaded in memory between jobs.
"""

from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from nebula_host import db

MAX_CHARS = 1500
_sem = asyncio.Semaphore(1)
_voice_cache: dict[str, Any] = {"at": 0.0, "voices": []}
DEFAULT_VOICE = {"cs": "Zuzana", "en": "Samantha"}


class TTSError(Exception):
    pass


def settings() -> dict[str, Any]:
    return {"provider": "macos", "cloud_consent": False, "cloud_model": "gpt-4o-mini-tts", "cloud_voice": "alloy",
            **(db.get_setting("voice.tts", {}) or {})}


def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg", path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")


def voices(force: bool = False) -> list[dict[str, str]]:
    if not force and time.time() - _voice_cache["at"] < 3600 and _voice_cache["voices"]:
        return _voice_cache["voices"]
    out: list[dict[str, str]] = []
    if shutil.which("say"):
        r = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=20)
        for line in r.stdout.splitlines():
            m = re.match(r"^(.+?)\s{2,}([a-z]{2}_[A-Z]{2}|[a-z]{2}-[A-Z]{2})\s+#\s*(.*)$", line)
            if m:
                out.append({"id": m.group(1).strip(), "locale": m.group(2).replace("-", "_"),
                            "language": m.group(2)[:2], "sample": m.group(3)[:80], "provider": "macos"})
    _voice_cache.update(at=time.time(), voices=out)
    return out


def status() -> dict[str, Any]:
    s = settings()
    from nebula_host import stt

    vs = voices()
    cloud_ready = stt._openai_key() is not None if hasattr(stt, "_openai_key") else False
    return {"providers": {
        "macos": {"available": bool(shutil.which("say")), "voices": len(vs),
                  "czech": [v["id"] for v in vs if v["language"] == "cs"],
                  "english": [v["id"] for v in vs if v["language"] == "en"][:20],
                  "ogg_opus": bool(_ffmpeg()), "local": True},
        "openai": {"available": cloud_ready, "consent": bool(s["cloud_consent"]), "local": False}},
        "default_provider": s["provider"]}


def pick_voice(language: str, wanted: str | None = None) -> str | None:
    vs = voices()
    if wanted and any(v["id"] == wanted for v in vs):
        return wanted
    lang = (language or "en")[:2]
    pref = DEFAULT_VOICE.get(lang)
    if pref and any(v["id"] == pref for v in vs):
        return pref
    return next((v["id"] for v in vs if v["language"] == lang), None)


def clean_for_speech(text: str) -> str:
    t = re.sub(r"```.*?```", " (code omitted) ", text or "", flags=re.S)
    t = re.sub(r"https?://\S+", " (link) ", t)
    t = re.sub(r"[*_#`>|]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:MAX_CHARS]


async def synthesize(text: str, *, language: str = "en", voice: str | None = None, rate: float = 1.0,
                     provider: str | None = None, fmt: str = "ogg") -> dict[str, Any]:
    text = clean_for_speech(text)
    if not text:
        raise TTSError("nothing to say")
    prov = provider or settings()["provider"]
    if prov == "openai" and not settings()["cloud_consent"]:
        prov = "macos"  # no consent -> never send text to the cloud; local voice instead
    async with _sem:
        if prov == "openai":
            return await _openai(text, voice)
        return await asyncio.to_thread(_macos, text, language, voice, rate, fmt)


def _macos(text: str, language: str, voice: str | None, rate: float, fmt: str) -> dict[str, Any]:
    if not shutil.which("say"):
        raise TTSError("macOS `say` is not available")
    v = pick_voice(language, voice)
    if not v:
        raise TTSError(f"no macOS voice for language {language!r} (System Settings → Accessibility → Spoken Content)")
    wpm = int(max(0.5, min(rate or 1.0, 2.0)) * 180)
    with tempfile.TemporaryDirectory(prefix="nebula-tts-") as td:
        src, aiff = Path(td) / "in.txt", Path(td) / "out.aiff"
        src.write_text(text)
        subprocess.run(["say", "-v", v, "-r", str(wpm), "-f", str(src), "-o", str(aiff)], check=True, timeout=120,
                       capture_output=True)
        ff = _ffmpeg()
        if ff and fmt == "ogg":
            out = Path(td) / "out.ogg"
            subprocess.run([ff, "-nostdin", "-loglevel", "error", "-i", str(aiff), "-c:a", "libopus", "-b:a", "32k",
                            "-ar", "48000", "-ac", "1", "-application", "voip", "-y", str(out)], check=True, timeout=120)
            mime = "audio/ogg"
        else:
            out = Path(td) / "out.m4a"
            subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", str(aiff), str(out)], check=True, timeout=120)
            mime = "audio/mp4"
        data = out.read_bytes()
        dur = _duration(ff, out)
    return {"audio": data, "mime": mime, "format": out.suffix[1:], "voice": v, "provider": "macos (local)",
            "duration_s": dur, "chars": len(text)}


def _duration(ff: str | None, p: Path) -> float | None:
    probe = shutil.which("ffprobe", path="/opt/homebrew/bin:/usr/local/bin:/usr/bin")
    if not probe:
        return None
    r = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(p)],
                       capture_output=True, text=True, timeout=20)
    try:
        return round(float(r.stdout.strip()), 2)
    except ValueError:
        return None


async def _openai(text: str, voice: str | None) -> dict[str, Any]:
    import httpx

    from nebula_host import stt

    s = settings()
    if not s["cloud_consent"]:
        raise TTSError("cloud TTS needs your explicit consent in Settings → Voice (text would be sent to OpenAI)")
    key = stt._openai_key()
    if not key:
        raise TTSError("OpenAI API key not connected")
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post("https://api.openai.com/v1/audio/speech", headers={"Authorization": f"Bearer {key}"},
                         json={"model": s["cloud_model"], "voice": voice or s["cloud_voice"], "input": text,
                               "response_format": "opus"})
    if r.status_code >= 400:
        raise TTSError(f"OpenAI TTS failed: HTTP {r.status_code}")
    return {"audio": r.content, "mime": "audio/ogg", "format": "ogg", "voice": voice or s["cloud_voice"],
            "provider": "openai (cloud, consented)", "duration_s": None, "chars": len(text)}
