#!/usr/bin/env python3
"""Build F2 (subtitle package), F3 (chapter package) and F5 (replacement).

All media comes from the real F1 package; no toy videos are used. ffmpeg is
used only to copy/truncate real media and to inject a real MP4 chapter track.

Run: python3 -I scripts/build_packages.py [--only f2|f3|f5]
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_common import (  # noqa: E402
    FIXTURE_ROOT,
    ffprobe_summary,
    reset_dir,
    write_json,
    zip_dir,
)
from fixture_manifest import build_manifest, specs_for, write_manifest  # noqa: E402

DATA = FIXTURE_ROOT / "data" / "course_content.json"
F1_PKG = FIXTURE_ROOT / "F1" / "package" / "Modeling life内容文件"
SCRIPTS = Path(__file__).resolve().parent
EXPORTED_AT = "2026-11-13T00:00:00Z"

REAL_FILES = {
    "l1-video": F1_PKG / "Lesson 1视频课件.mp4",
    "l2-video": F1_PKG / "Lesson 2视频课件.mp4",
    "l1-doc": F1_PKG / "Lesson 1 文本课件.docx",
    "l2-doc": F1_PKG / "Lesson 2文本课件.docx",
    "cover": F1_PKG / "课程封面.png",
    "l1-ex1": F1_PKG / "lesson1-exhibit-1.png",
    "l1-ex2": F1_PKG / "lesson1-exhibit-2.png",
    "l1-ex1-thumb": F1_PKG / "lesson1-exhibit1缩略图.png",
    "l1-ex2-thumb": F1_PKG / "lesson1-exhibit2缩略图.png",
}


def run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(
            f"command failed ({result.returncode}): {' '.join(cmd)}\n"
            f"stderr:\n{result.stderr[-4000:]}"
        )


def copy_common(pkg: Path, include_subtitles: bool) -> None:
    (pkg / "media").mkdir(parents=True, exist_ok=True)
    (pkg / "lessons").mkdir(parents=True, exist_ok=True)
    (pkg / "subtitles").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REAL_FILES["cover"], pkg / "media" / "cover.png")
    shutil.copyfile(REAL_FILES["l1-doc"], pkg / "lessons" / "l1.docx")
    shutil.copyfile(REAL_FILES["l2-doc"], pkg / "lessons" / "l2.docx")
    for key in ("l1-ex1", "l1-ex2", "l1-ex1-thumb", "l1-ex2-thumb"):
        shutil.copyfile(REAL_FILES[key], pkg / "media" / f"{key}.png")
    if not include_subtitles:
        (pkg / "subtitles").rmdir()


def build_workbook(variant: str, out: Path, data_path: Path | None = None) -> None:
    cmd = ["node", str(SCRIPTS / "build_workbook.mjs"), "--variant", variant,
           "--out", str(out)]
    if data_path is not None:
        cmd += ["--data", str(data_path)]
    run(cmd)


def build_subtitles(lesson: str, duration_ms: int, fmt: str, out: Path) -> None:
    run([
        sys.executable, "-I", str(SCRIPTS / "build_subtitles.py"),
        "--data", str(DATA), "--lesson", lesson,
        "--duration-ms", str(duration_ms), "--format", fmt,
        "--out", str(out),
    ])


def chapter_metadata(chapters: list[tuple[int, int, str]], out: Path) -> None:
    lines = [";FFMETADATA1"]
    for start, end, title in chapters:
        lines += [
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={start}",
            f"END={end}",
            f"title={title}",
        ]
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def inject_chapters(src: Path, dst: Path, chapters: list[tuple[int, int, str]]) -> None:
    meta = dst.with_suffix(".chapters.txt")
    chapter_metadata(chapters, meta)
    run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src), "-i", str(meta),
        "-map", "0", "-map_metadata", "1", "-map_chapters", "1",
        "-codec", "copy", str(dst),
    ])
    meta.unlink()


def lesson_chapters(lesson: dict, duration_ms: int) -> list[tuple[int, int, str]]:
    lps = lesson["learningPoints"]
    margin = 2000
    usable = duration_ms - margin
    step = usable / len(lps)
    chapters = []
    for index, lp in enumerate(lps):
        start = margin + int(index * step)
        end = margin + int((index + 1) * step) if index + 1 < len(lps) else duration_ms
        chapters.append((start, end, lp["titleEn"]))
    return chapters


def make_package(name: str, *, timing_source: str, version_no: int,
                 l1_video_version: int, f5: bool = False) -> dict:
    base = FIXTURE_ROOT / name
    pkg = base / "package"
    if base.exists():
        shutil.rmtree(base)
    reset_dir(pkg)
    data = json.loads(DATA.read_text(encoding="utf-8"))

    copy_common(pkg, include_subtitles=(timing_source == "subtitle"))
    probes = {}

    if timing_source == "chapter":
        for lesson_key, lesson in zip(("L1", "L2"), data["lessons"]):
            src = REAL_FILES[f"{lesson_key.lower()}-video"]
            dst = pkg / "media" / f"{lesson_key.lower()}-video.mp4"
            duration = ffprobe_summary(src)["durationMs"]
            inject_chapters(src, dst, lesson_chapters(lesson, duration))
            probes[lesson_key] = ffprobe_summary(dst)
            if probes[lesson_key]["chapters"] != len(lesson["learningPoints"]):
                raise SystemExit(
                    f"chapter injection failed for {lesson_key}: "
                    f"{probes[lesson_key]['chapters']} chapters"
                )
    else:
        for lesson_key in ("L1", "L2"):
            src = REAL_FILES[f"{lesson_key.lower()}-video"]
            dst = pkg / "media" / f"{lesson_key.lower()}-video.mp4"
            if f5 and lesson_key == "L1":
                # Truncate the real Lesson 1 video to ~20 minutes (different duration).
                run([
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-i", str(src), "-t", "1200", "-c", "copy", str(dst),
                ])
            else:
                shutil.copyfile(src, dst)
            probes[lesson_key] = ffprobe_summary(dst)

        build_subtitles(
            "L1", probes["L1"]["durationMs"], "srt",
            pkg / "subtitles" / "l1.en-GB.srt",
        )
        build_subtitles(
            "L2", probes["L2"]["durationMs"], "vtt",
            pkg / "subtitles" / "l2.en-GB.vtt",
        )
        # Alternate encodings are kept outside the package for evidence/reuse.
        alt = base / "alternates"
        alt.mkdir(exist_ok=True)
        build_subtitles(
            "L1", probes["L1"]["durationMs"], "vtt", alt / "l1.en-GB.vtt"
        )
        build_subtitles(
            "L2", probes["L2"]["durationMs"], "srt", alt / "l2.en-GB.srt"
        )

    build_workbook("f3" if timing_source == "chapter" else "f2",
                   pkg / "template.xlsx", DATA)

    specs = specs_for(timing_source)
    manifest = build_manifest(
        data, pkg, specs,
        version_no=version_no,
        l1_video_version=l1_video_version,
        timing_sources=[timing_source],
        exported_at=EXPORTED_AT,
    )
    write_manifest(pkg, manifest)
    zip_path = base / f"{name}.zip"
    zip_dir(pkg, zip_path)

    summary = {
        "name": name,
        "zip": str(zip_path),
        "zipSize": zip_path.stat().st_size,
        "timingSource": timing_source,
        "versionNo": version_no,
        "l1VideoVersion": l1_video_version,
        "media": probes,
        "resources": manifest["resources"],
    }
    write_json(base / "build.json", summary)
    print(
        f"{name}: zip={zip_path.stat().st_size} bytes, "
        f"L1={probes['L1']['durationMs']}ms, L2={probes['L2']['durationMs']}ms, "
        f"timing={timing_source}"
    )
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["f2", "f3", "f5"], default=None)
    args = parser.parse_args()
    if not DATA.exists():
        raise SystemExit(f"missing {DATA}; run build_course_data.py first")
    if args.only in (None, "f2"):
        make_package("F2_subtitles", timing_source="subtitle",
                     version_no=1, l1_video_version=1)
    if args.only in (None, "f3"):
        make_package("F3_chapters", timing_source="chapter",
                     version_no=1, l1_video_version=1)
    if args.only in (None, "f5"):
        make_package("F5_replacement", timing_source="subtitle",
                     version_no=2, l1_video_version=2, f5=True)


if __name__ == "__main__":
    main()
