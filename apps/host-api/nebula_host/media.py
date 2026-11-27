"""Local media/document processing for multimodal attachments (host side, no cloud).

All inputs are untrusted: type detection by magic bytes (never by the declared MIME alone), bounded sizes, safe ZIP
inspection (no traversal, no symlinks, entry/size/ratio limits), DOCX parsed without DTDs, external tools (ffmpeg,
ffprobe, pdftotext, sips) run with timeouts and fixed argument lists.
"""

from __future__ import annotations

import csv
import io
import json
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

TOOLS_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
ZIP_MAX_ENTRIES = 2000
ZIP_MAX_TOTAL = 200 * 1024 * 1024
ZIP_MAX_RATIO = 120
TEXT_EXCERPT = 6000
CODE_EXT = {".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs",
            ".rb", ".php", ".swift", ".sh", ".sql", ".html", ".htm", ".css", ".scss", ".yaml", ".yml", ".toml",
            ".ini", ".cfg", ".xml", ".md", ".dart", ".vue", ".svelte", ".m", ".mm", ".gradle", ".lua", ".r"}
TEXT_EXT = {".txt", ".log", ".md", ".rst"}


class MediaError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


def which(name: str) -> str | None:
    return shutil.which(name, path=TOOLS_PATH)


def safe_name(name: str, fallback: str = "file") -> str:
    base = Path((name or "").replace("\\", "/")).name
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base).strip(" .")
    base = re.sub(r"\.{2,}", ".", base)
    return (base or fallback)[:120]


# ---------------------------------------------------------------------------- detection
BLOCKED_EXT = {".exe", ".dll", ".msi", ".scr", ".com", ".bat", ".cmd", ".pif", ".app", ".dmg", ".pkg", ".jar",
               ".apk", ".ipa", ".deb", ".rpm", ".vbs", ".ps1", ".lnk", ".command", ".workflow"}


def sniff(data: bytes, name: str = "", declared: str = "") -> tuple[str, str]:
    """(kind, mime) from content. Raises MediaError for executables / unknown binaries."""
    h = data[:64]
    ext = Path(name or "").suffix.lower()
    if ext in BLOCKED_EXT or declared in ("application/x-msdownload", "application/x-msdos-program",
                                          "application/x-apple-diskimage", "application/vnd.android.package-archive"):
        raise MediaError("executable_rejected", "executables and installers are not accepted")
    if h.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "image/png"
    if h[:3] == b"\xff\xd8\xff":
        return "image", "image/jpeg"
    if h[:6] in (b"GIF87a", b"GIF89a"):
        return "image", "image/gif"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":
        return "image", "image/webp"
    if h[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1"):
        return "image", "image/heic"
    if h[:5] == b"%PDF-":
        return "pdf", "application/pdf"
    if h[:4] == b"OggS":
        return "audio", "audio/ogg"
    if h[:4] == b"RIFF" and h[8:12] == b"WAVE":
        return "audio", "audio/wav"
    if h[:3] == b"ID3" or (len(h) > 1 and h[0] == 0xFF and (h[1] & 0xE0) == 0xE0):
        return "audio", "audio/mpeg"
    if h[:4] == b"fLaC":
        return "audio", "audio/flac"
    if h[4:8] == b"ftyp":
        brand = h[8:12]
        if brand in (b"M4A ", b"M4B "):
            return "audio", "audio/mp4"
        return "video", "video/quicktime" if brand == b"qt  " else "video/mp4"
    if h[:4] == b"\x1a\x45\xdf\xa3":
        return "video", "video/webm"
    if h[:4] == b"PK\x03\x04" or h[:4] == b"PK\x05\x06":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
            names = set(zf.namelist()[:5000])
        except zipfile.BadZipFile as e:
            raise MediaError("bad_zip", "corrupt ZIP container") from e
        if "word/document.xml" in names:
            return "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if "xl/workbook.xml" in names:
            return "zip", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        return "zip", "application/zip"
    if h[:4] in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe") or h[:2] == b"MZ":
        raise MediaError("executable_rejected", "executables are not accepted")
    # text-ish
    sample = data[:65536]
    if b"\x00" in sample:
        raise MediaError("unsupported_type", f"unsupported binary file type ({declared or ext or 'unknown'})")
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError:
        try:
            sample.decode("utf-16")
        except UnicodeDecodeError:
            raise MediaError("unsupported_type", "binary data that is not a supported format") from None
    if ext == ".json" or declared == "application/json":
        return "json", "application/json"
    if ext in (".csv", ".tsv") or declared in ("text/csv", "text/tab-separated-values"):
        return "csv", "text/csv"
    if ext in CODE_EXT:
        return "code", "text/plain"
    stripped = sample.lstrip()[:1]
    if stripped in (b"{", b"[") and ext not in TEXT_EXT:
        try:
            json.loads(data.decode("utf-8"))
            return "json", "application/json"
        except (ValueError, UnicodeDecodeError):
            pass
    return "text", "text/plain"


# ---------------------------------------------------------------------------- zip safety
def zip_inspect(data: bytes, *, extract_text_to: Path | None = None, max_text_files: int = 30) -> dict[str, Any]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise MediaError("bad_zip", "not a valid ZIP archive") from e
    infos = zf.infolist()
    if len(infos) > ZIP_MAX_ENTRIES:
        raise MediaError("zip_too_many_entries", f"more than {ZIP_MAX_ENTRIES} entries")
    total = sum(i.file_size for i in infos)
    comp = sum(max(i.compress_size, 1) for i in infos)
    if total > ZIP_MAX_TOTAL:
        raise MediaError("zip_too_large", "unpacks to more than 200 MB")
    if comp and total / comp > ZIP_MAX_RATIO and total > 10 * 1024 * 1024:
        raise MediaError("zip_bomb", f"suspicious compression ratio ({total // comp}:1)")
    entries, unsafe = [], []
    for i in infos:
        n = i.filename.replace("\\", "/")
        parts = [p for p in n.split("/") if p not in ("", ".")]
        is_link = (i.external_attr >> 16) & 0o170000 == 0o120000
        if n.startswith("/") or ".." in parts or is_link or re.match(r"^[A-Za-z]:", n):
            unsafe.append(n)
            continue
        if i.file_size and i.compress_size and i.file_size / max(i.compress_size, 1) > ZIP_MAX_RATIO * 10:
            raise MediaError("zip_bomb", f"entry {n!r} has an extreme compression ratio")
        entries.append({"path": "/".join(parts), "size": i.file_size, "dir": i.is_dir()})
    out: dict[str, Any] = {"entries": len(entries), "total_bytes": total, "unsafe_entries": unsafe[:20],
                           "listing": [e["path"] + ("/" if e["dir"] else "") for e in entries[:300]]}
    if extract_text_to is not None:
        extract_text_to.mkdir(parents=True, exist_ok=True)
        n = 0
        texts = []
        for e in entries:
            if e["dir"] or e["size"] > 200_000 or n >= max_text_files:
                continue
            ext = Path(e["path"]).suffix.lower()
            if ext not in CODE_EXT and ext not in TEXT_EXT and ext not in (".json", ".csv", ".tsv"):
                continue
            raw = zf.read(e["path"])
            if b"\x00" in raw[:4096]:
                continue
            dest = extract_text_to / safe_name(e["path"].replace("/", "__"))
            dest.write_bytes(raw)
            texts.append({"path": e["path"], "excerpt": raw[:800].decode(errors="replace")})
            n += 1
        out["text_files"] = texts
    return out


# ---------------------------------------------------------------------------- documents
def docx_text(data: bytes) -> str:
    info = zip_inspect(data)
    if info["unsafe_entries"]:
        raise MediaError("unsafe_docx", "DOCX container has unsafe entries")
    zf = zipfile.ZipFile(io.BytesIO(data))
    xml = zf.read("word/document.xml")
    if b"<!DOCTYPE" in xml[:2000] or b"<!ENTITY" in xml:
        raise MediaError("unsafe_docx", "DOCX with DTD/entities rejected")
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    root = ElementTree.fromstring(xml)  # noqa: S314 - DTD/entity declarations are rejected above
    paras = []
    for p in root.iter(f"{ns}p"):
        t = "".join(x.text or "" for x in p.iter(f"{ns}t"))
        if t.strip():
            paras.append(t)
    return "\n".join(paras)


def pdf_text(path: Path) -> dict[str, Any]:
    exe = which("pdftotext")
    if not exe:
        raise MediaError("tool_missing", "pdftotext (poppler) is not installed")
    r = subprocess.run([exe, "-layout", "-enc", "UTF-8", str(path), "-"], capture_output=True, timeout=120)
    if r.returncode != 0:
        raise MediaError("pdf_failed", r.stderr.decode(errors="replace")[:300] or "pdftotext failed")
    pages = None
    info = which("pdfinfo")
    if info:
        ri = subprocess.run([info, str(path)], capture_output=True, text=True, timeout=30)
        m = re.search(r"Pages:\s+(\d+)", ri.stdout)
        pages = int(m.group(1)) if m else None
    return {"text": r.stdout.decode(errors="replace"), "pages": pages}


def csv_summary(text: str) -> dict[str, Any]:
    sample = text[:200_000]
    try:
        dialect = csv.Sniffer().sniff(sample[:5000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(sample), dialect))
    header = rows[0] if rows else []
    return {"rows": max(len(text.splitlines()) - 1, 0), "columns": header[:60], "column_count": len(header),
            "head": rows[1:6]}


def json_summary(text: str) -> dict[str, Any]:
    try:
        obj = json.loads(text)
    except ValueError as e:
        return {"valid": False, "error": str(e)[:200]}
    if isinstance(obj, dict):
        return {"valid": True, "type": "object", "keys": list(obj.keys())[:60]}
    if isinstance(obj, list):
        first = obj[0] if obj else None
        return {"valid": True, "type": "array", "length": len(obj),
                "item_keys": list(first.keys())[:60] if isinstance(first, dict) else None}
    return {"valid": True, "type": type(obj).__name__}


# ---------------------------------------------------------------------------- images / audio / video
def image_info(path: Path) -> dict[str, Any]:
    exe = which("sips")
    if not exe:
        return {}
    r = subprocess.run([exe, "-g", "pixelWidth", "-g", "pixelHeight", str(path)], capture_output=True, text=True,
                       timeout=20)
    w = re.search(r"pixelWidth:\s*(\d+)", r.stdout)
    h = re.search(r"pixelHeight:\s*(\d+)", r.stdout)
    return {"width": int(w.group(1)) if w else None, "height": int(h.group(1)) if h else None}


def image_for_model(src: Path, dest: Path, max_side: int = 1568) -> Path:
    """Downscale + re-encode to JPEG (drops metadata such as GPS) for model input."""
    exe = which("sips")
    if not exe:
        shutil.copyfile(src, dest)
        return dest
    r = subprocess.run([exe, "-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", str(max_side), str(src),
                        "--out", str(dest)], capture_output=True, timeout=60)
    if r.returncode != 0 or not dest.exists():
        raise MediaError("image_failed", "could not decode the image")
    return dest


def probe(path: Path) -> dict[str, Any]:
    exe = which("ffprobe")
    if not exe:
        raise MediaError("tool_missing", "ffprobe (ffmpeg) is not installed")
    r = subprocess.run([exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise MediaError("probe_failed", r.stderr[:300] or "ffprobe failed")
    j = json.loads(r.stdout or "{}")
    fmt = j.get("format") or {}
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    fps = None
    if v and v.get("avg_frame_rate") and "/" in v["avg_frame_rate"]:
        n, d = v["avg_frame_rate"].split("/")
        fps = round(int(n) / int(d), 2) if int(d or 0) else None
    return {"duration_s": round(float(fmt.get("duration") or 0), 2), "format": fmt.get("format_name"),
            "bit_rate": int(fmt.get("bit_rate") or 0) or None,
            "video": {"codec": v.get("codec_name"), "width": v.get("width"), "height": v.get("height"), "fps": fps}
            if v else None, "audio": {"codec": a.get("codec_name"), "channels": a.get("channels"),
                                      "sample_rate": a.get("sample_rate")} if a else None}


def extract_frames(path: Path, out_dir: Path, duration: float, *, max_frames: int = 6, every_s: float | None = None,
                   width: int = 768) -> list[dict[str, Any]]:
    """Sample at most `max_frames` frames (evenly, or every `every_s` seconds) — never every frame."""
    exe = which("ffmpeg")
    if not exe:
        raise MediaError("tool_missing", "ffmpeg is not installed")
    out_dir.mkdir(parents=True, exist_ok=True)
    max_frames = max(1, min(max_frames, 12))
    if duration <= 0:
        times = [0.0]
    elif every_s:
        times = [t for t in [i * every_s for i in range(int(duration // every_s) + 1)] if t < duration][:max_frames]
    else:
        step = duration / (max_frames + 1)
        times = [round(step * (i + 1), 2) for i in range(max_frames)]
    frames = []
    for i, t in enumerate(times):
        dest = out_dir / f"frame-{i:02d}.jpg"
        r = subprocess.run([exe, "-nostdin", "-loglevel", "error", "-threads", "2", "-ss", f"{t:.2f}", "-i", str(path),
                            "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", "-y", str(dest)],
                           capture_output=True, timeout=60)
        if r.returncode == 0 and dest.exists():
            frames.append({"t": t, "file": dest.name})
    return frames


def extract_audio(path: Path, dest: Path, max_s: int = 600) -> Path:
    exe = which("ffmpeg")
    if not exe:
        raise MediaError("tool_missing", "ffmpeg is not installed")
    r = subprocess.run([exe, "-nostdin", "-loglevel", "error", "-threads", "2", "-i", str(path), "-vn", "-t", str(max_s),
                        "-ar", "16000", "-ac", "1", "-y", str(dest)], capture_output=True, timeout=300)
    if r.returncode != 0 or not dest.exists():
        raise MediaError("audio_failed", r.stderr.decode(errors="replace")[:200] or "no audio track")
    return dest
