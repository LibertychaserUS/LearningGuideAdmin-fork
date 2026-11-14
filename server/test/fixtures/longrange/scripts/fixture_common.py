#!/usr/bin/env python3
"""Shared helpers for the long-range real-test fixtures.

All scripts are black-box fixture builders: they never import product code.
They only read/write files under this fixture tree plus the real source zip.

Run every script with `python3 -I` so a planted json.py next to the inputs can
never shadow the stdlib.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

# Absolute path of the real Modeling life content zip supplied by the Owner.
REAL_ZIP = Path(
    "/Users/nihao/Library/Containers/com.tencent.xinWeChat/Data/Documents/"
    "xwechat_files/wxid_2r9lp9dzjsqc22_8c54/msg/attach/"
    "97a7391c0f3e5cbcfee4a9785c2f4c05/2026-11/Rec/3a59f264fcf791b8/F/1/"
    "Modeling life内容文件.zip"
)

FIXTURE_ROOT = Path(__file__).resolve().parent.parent

# Directories that are not part of the content package.
JUNK_DIRS = ("__MACOSX/",)
JUNK_NAMES = (".DS_Store",)
# Excel lock files ("~$foo.xlsx") are transient owner-side artifacts.
JUNK_PREFIXES = ("~$",)


def fixed_name(info: zipfile.ZipInfo) -> str:
    """Recover the real UTF-8 name from a ZIP that may lack the UTF-8 flag.

    The Owner's zip stores UTF-8 bytes but the top-level directory entry does
    not set bit 3 (0x800). Python therefore decodes those names as cp437.
    Re-encoding cp437 gives the original bytes back; we then try UTF-8 first
    and fall back to GBK/GB18030 for genuinely legacy archives.
    """
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    raw = name.encode("cp437", errors="strict")
    for enc in ("utf-8", "gb18030", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return name


def is_junk(name: str) -> bool:
    if any(part in name for part in JUNK_DIRS):
        return True
    base = name.rsplit("/", 1)[-1]
    if base in JUNK_NAMES:
        return True
    if base.startswith(JUNK_PREFIXES):
        return True
    return False


def safe_extract_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo,
                        dest: Path) -> Path:
    """Extract one member, rejecting any path that escapes `dest`."""
    rel = fixed_name(info)
    target = (dest / rel).resolve()
    dest_resolved = dest.resolve()
    if not str(target).startswith(str(dest_resolved) + os.sep) and target != dest_resolved:
        raise SystemExit(f"zip path traversal blocked: {rel!r}")
    if info.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    with zf.open(info) as src, open(target, "wb") as out:
        shutil.copyfileobj(src, out)
    return target


def ffprobe(path: Path) -> dict:
    """Return container/stream/chapter facts via ffprobe (no product imports)."""
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", "-show_chapters", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def ffprobe_summary(path: Path) -> dict:
    data = ffprobe(path)
    video = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    audio = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    fmt = data.get("format", {})
    return {
        "path": str(path),
        "name": path.name,
        "size": path.stat().st_size,
        "durationMs": int(round(float(fmt.get("duration", 0)) * 1000)),
        "formatName": fmt.get("format_name"),
        "videoStreams": len(video),
        "audioStreams": len(audio),
        "videoCodec": video[0].get("codec_name") if video else None,
        "width": video[0].get("width") if video else None,
        "height": video[0].get("height") if video else None,
        "chapters": len(data.get("chapters", []) or []),
        "subtitleStreams": len(
            [s for s in data.get("streams", []) if s.get("codec_type") == "subtitle"]
        ),
    }


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)


def zip_dir(src_dir: Path, out_zip: Path) -> None:
    """Deterministic-ish zip of a directory (sorted names, fixed mtime)."""
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    if out_zip.exists():
        out_zip.unlink()
    entries = sorted(p for p in src_dir.rglob("*"))
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in entries:
            rel = p.relative_to(src_dir)
            arc = rel.as_posix()
            if p.is_dir():
                zf.writestr(zipfile.ZipInfo(arc + "/"), b"")
                continue
            info = zipfile.ZipInfo(arc, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, p.read_bytes())
