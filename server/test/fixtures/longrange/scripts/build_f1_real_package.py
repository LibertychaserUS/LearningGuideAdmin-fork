#!/usr/bin/env python3
"""F1 — extract and inventory the real Modeling life content package.

Reproducible: run with `python3 -I scripts/build_f1_real_package.py`.

Outputs (under F1/):
  package/            extracted content folder (cp437 -> utf-8 names fixed)
  inventory.json      every zip entry with fixed name, size, junk flag
  ffprobe.json        real duration / stream / chapter facts for both mp4s
  inventory.txt       human-readable listing

The Owner's zip has no subtitle files and no MP4 chapter tracks; this script
records that absence as `hasSubtitles` / `hasChapterTracks` so F1 can later be
asserted to have no derivation source.
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_common import (  # noqa: E402
    FIXTURE_ROOT,
    REAL_ZIP,
    ffprobe_summary,
    fixed_name,
    is_junk,
    reset_dir,
    safe_extract_member,
    write_json,
)

F1_DIR = FIXTURE_ROOT / "F1"
PKG = F1_DIR / "package"


def main() -> None:
    if not REAL_ZIP.exists():
        raise SystemExit(f"real zip not found: {REAL_ZIP}")

    reset_dir(PKG)
    entries = []
    with zipfile.ZipFile(REAL_ZIP) as zf:
        for info in zf.infolist():
            name = fixed_name(info)
            junk = is_junk(name)
            entry = {
                "name": name,
                "rawName": info.filename,
                "utf8Flag": bool(info.flag_bits & 0x800),
                "size": info.file_size,
                "compressedSize": info.compress_size,
                "isDir": info.is_dir(),
                "junk": junk,
            }
            entries.append(entry)
            if not junk:
                safe_extract_member(zf, info, PKG)

    content = [e for e in entries if not e["junk"]]
    media = [p for p in PKG.rglob("*") if p.is_file()]
    mp4s = sorted(p for p in media if p.suffix.lower() == ".mp4")
    subtitle_files = sorted(
        p for p in media if p.suffix.lower() in (".srt", ".vtt", ".ass", ".ssa")
    )

    probes = [ffprobe_summary(p) for p in mp4s]

    inventory = {
        "sourceZip": str(REAL_ZIP),
        "sourceZipSize": REAL_ZIP.stat().st_size,
        "entryCount": len(entries),
        "contentEntryCount": len(content),
        "junkEntryCount": len(entries) - len(content),
        "entries": entries,
        "contentFiles": [
            {
                "path": str(p.relative_to(PKG)),
                "size": p.stat().st_size,
                "kind": p.suffix.lower().lstrip("."),
            }
            for p in sorted(media)
        ],
        "kinds": {},
        "hasSubtitles": bool(subtitle_files),
        "subtitleFiles": [str(p.relative_to(PKG)) for p in subtitle_files],
        "hasChapterTracks": any(p["chapters"] > 0 for p in probes),
        "media": probes,
    }
    for f in inventory["contentFiles"]:
        inventory["kinds"][f["kind"]] = inventory["kinds"].get(f["kind"], 0) + 1
    write_json(F1_DIR / "inventory.json", inventory)
    write_json(F1_DIR / "ffprobe.json", probes)

    lines = [
        f"source zip: {REAL_ZIP}",
        f"entries: {len(entries)} (content {len(content)}, junk "
        f"{len(entries) - len(content)})",
        "content files:",
    ]
    for f in inventory["contentFiles"]:
        lines.append(f"  {f['size']:>10}  {f['path']}")
    lines.append("media probe:")
    for p in probes:
        lines.append(
            f"  {p['name']}: durationMs={p['durationMs']} "
            f"video={p['videoStreams']} audio={p['audioStreams']} "
            f"chapters={p['chapters']} subtitles={p['subtitleStreams']}"
        )
    lines.append(
        f"hasSubtitles={inventory['hasSubtitles']} "
        f"hasChapterTracks={inventory['hasChapterTracks']}"
    )
    (F1_DIR / "inventory.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
