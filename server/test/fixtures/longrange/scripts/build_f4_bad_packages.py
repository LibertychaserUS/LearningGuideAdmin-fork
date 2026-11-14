#!/usr/bin/env python3
"""F4 — nine minimal invalid packages, one defect each.

Baseline is a minimal Part C v2 package built from *real* media: a 10 s excerpt
of the real Lesson 2 video and a real cover-derived thumbnail. Each case then
changes exactly one thing, so the long-range suite can assert fail-closed
behaviour per defect.

Cases:
  1 missing-manifest-field   course.titleLocalized removed
  2 unknown-file             undeclared media/orphan.bin added to the zip
  3 version-missing          manifest.formatVersion removed
  4 duplicate-truth-key      duplicate (lesson_code, lp_code, language) row
  5 out-of-range-time        subtitle cue starts beyond the real duration
  6 unknown-code             Knowledge Test references unknown lesson_code
  7 missing-language         video Media row carries no language
  8 illegal-media-type       manifest resource kind set to an unknown kind
  9 zip-path-traversal       extra zip entry named ../evil.txt

Run: python3 -I scripts/build_f4_bad_packages.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_common import (  # noqa: E402
    FIXTURE_ROOT,
    ffprobe_summary,
    reset_dir,
    write_json,
    zip_dir,
)

SCRIPTS = Path(__file__).resolve().parent
F1_PKG = FIXTURE_ROOT / "F1" / "package" / "Modeling life内容文件"
BASE = FIXTURE_ROOT / "F4_bad_packages"
BASELINE = BASE / "_baseline"
EXPORTED_AT = "2026-11-13T00:00:00Z"

COURSE_KEY = "bad-baseline"
LESSON = "BL1"
LP_TITLE = "Baseline learning point"


def run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(
            f"command failed: {' '.join(cmd)}\n{result.stderr[-3000:]}"
        )


def make_small_cover(src: Path, dst: Path) -> None:
    run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-vf", "scale=64:64", "-frames:v", "1", str(dst),
    ])


def make_real_excerpt(src: Path, dst: Path) -> None:
    run([
        "ffmpeg", "-y", "-loglevel", "error", "-ss", "10", "-i", str(src),
        "-t", "10", "-c", "copy", str(dst),
    ])


def srt(start: str, end: str) -> str:
    return (
        "1\n"
        f"{start} --> {end}\n"
        f"{LP_TITLE}\n\n"
        "2\n"
        "00:00:04,000 --> 00:00:06,000\n"
        "Baseline content\n\n"
    )


def build_template(variant: str, out: Path) -> None:
    run([
        "node", str(SCRIPTS / "build_workbook.mjs"),
        "--variant", "bad", "--bad-variant", variant, "--out", str(out),
    ])


def baseline_manifest(pkg: Path) -> dict:
    def resource(resource_id, kind, path):
        return {
            "id": resource_id,
            "kind": kind,
            "path": path,
            "size": (pkg / path).stat().st_size,
        }

    return {
        "format": "lg-course-package",
        "formatVersion": 2,
        "packageId": "pkg_bad_baseline_v1",
        "exportedAt": EXPORTED_AT,
        "minReaderVersion": 2,
        "extensionsUsed": [],
        "extensionsRequired": [],
        "course": {
            "courseKey": COURSE_KEY,
            "titleLocalized": {"en-GB": {"title": "Bad baseline"}},
            "categoryPath": ["Science"],
            "learningLanguages": ["en-GB"],
            "studyMode": "video",
        },
        "content": {
            "courseKey": COURSE_KEY,
            "versionNo": 1,
            "categoryPath": ["Science"],
            "stages": [
                {
                    "courseKey": COURSE_KEY,
                    "stageKey": "program-bad-baseline",
                    "parentStageKey": None,
                    "orderKey": "000001",
                    "kind": "program",
                    "goal": "Bad baseline",
                    "objectiveKeys": [],
                    "exitEvidence": [],
                    "exitRollup": {"kind": "all"},
                    "status": "active",
                },
                {
                    "courseKey": COURSE_KEY,
                    "stageKey": "lesson-bl1",
                    "parentStageKey": "program-bad-baseline",
                    "orderKey": "000001.000001",
                    "kind": "step",
                    "goal": "Baseline lesson",
                    "objectiveKeys": ["obj-bl1"],
                    "exitEvidence": ["ev-bl1"],
                    "exitRollup": {"kind": "all"},
                    "status": "active",
                },
            ],
            "prerequisiteEdges": [],
            "specPins": [{"contentKey": LESSON, "version": 1}],
            "renditions": [],
            "alignments": [],
            "evidenceSpecs": [
                {
                    "evidenceKey": "ev-bl1",
                    "version": 1,
                    "kind": "artifact",
                    "objectiveKeys": ["obj-bl1"],
                    "measure": {
                        "kind": "artifact",
                        "instructions": "Complete the baseline artefact.",
                    },
                    "scoring": "pass-fail",
                    "threshold": 1,
                    "attempts": 1,
                }
            ],
            "assetPins": [
                {"assetKey": "bad-cover", "assetVersion": 1},
                {"assetKey": "bad-video", "assetVersion": 1},
                {"assetKey": "bad-sub", "assetVersion": 1},
            ],
        },
        "resources": [
            resource("template", "template", "template.xlsx"),
            resource("bad-cover", "cover", "media/cover.png"),
            resource("bad-video", "video", "media/bad-video.mp4"),
            resource("bad-sub", "subtitle", "subtitles/BL1.en-GB.srt"),
        ],
        "provenance": {
            "sourceEnv": "sandbox",
            "sourceVersionLabel": "1.0",
            "exportedAt": EXPORTED_AT,
            "exportedBy": "fixtures@example.com",
            "courseKey": COURSE_KEY,
            "planPin": {
                "planId": "plan/bad-baseline/content-v1/target-default/v1",
                "planVersion": 1,
            },
            "approvalRef": "APPROVED-BAD-1",
            "auditSummaryRef": "audit/bad-baseline/v1.json",
        },
        "annotations": {"generatedBy": "longrange-fixture-builder"},
    }


def refresh_sizes(manifest: dict, pkg: Path) -> None:
    for resource in manifest["resources"]:
        resource["size"] = (pkg / resource["path"]).stat().st_size


def build_baseline() -> dict:
    reset_dir(BASELINE)
    (BASELINE / "media").mkdir()
    (BASELINE / "subtitles").mkdir()
    make_small_cover(F1_PKG / "课程封面.png", BASELINE / "media" / "cover.png")
    make_real_excerpt(
        F1_PKG / "Lesson 2视频课件.mp4", BASELINE / "media" / "bad-video.mp4"
    )
    duration = ffprobe_summary(BASELINE / "media" / "bad-video.mp4")["durationMs"]
    if duration < 8000:
        raise SystemExit(f"real excerpt too short: {duration} ms")
    (BASELINE / "subtitles" / "BL1.en-GB.srt").write_text(
        srt("00:00:01,000", "00:00:03,000"), encoding="utf-8"
    )
    build_template("baseline", BASELINE / "template.xlsx")
    manifest = baseline_manifest(BASELINE)
    write_json(BASELINE / "manifest.json", manifest)
    return {"durationMs": duration, "manifest": manifest}


CASES = [
    ("01-missing-manifest-field", "missing-manifest-field"),
    ("02-unknown-file", "unknown-file"),
    ("03-version-missing", "version-missing"),
    ("04-duplicate-truth-key", "duplicate-truth-key"),
    ("05-out-of-range-time", "out-of-range-time"),
    ("06-unknown-code", "unknown-code"),
    ("07-missing-language", "missing-language"),
    ("08-illegal-media-type", "illegal-media-type"),
    ("09-zip-path-traversal", "zip-path-traversal"),
]

WORKBOOK_VARIANTS = {
    "duplicate-truth-key": "duplicate-key",
    "unknown-code": "unknown-code",
    "missing-language": "missing-language",
}


def main() -> None:
    baseline = build_baseline()
    duration = baseline["durationMs"]
    summary = {
        "baseline": {
            "durationMs": duration,
            "manifest": baseline["manifest"],
        },
        "cases": [],
    }

    for case_name, defect in CASES:
        case_dir = BASE / case_name
        if case_dir.exists():
            shutil.rmtree(case_dir)
        shutil.copytree(BASELINE, case_dir, copy_function=shutil.copyfile)
        manifest = json.loads(
            (case_dir / "manifest.json").read_text(encoding="utf-8")
        )

        if defect == "missing-manifest-field":
            del manifest["course"]["titleLocalized"]
        elif defect == "unknown-file":
            (case_dir / "media" / "orphan.bin").write_bytes(b"orphan\n")
        elif defect == "version-missing":
            del manifest["formatVersion"]
        elif defect == "out-of-range-time":
            start_ms = duration + 10_000
            end_ms = start_ms + 8_000
            stamp = lambda ms: (
                f"{ms // 3600000:02d}:{(ms // 60000) % 60:02d}:"
                f"{(ms // 1000) % 60:02d},{ms % 1000:03d}"
            )
            (case_dir / "subtitles" / "BL1.en-GB.srt").write_text(
                srt(stamp(start_ms), stamp(end_ms)), encoding="utf-8"
            )
        elif defect == "illegal-media-type":
            for resource in manifest["resources"]:
                if resource["id"] == "bad-video":
                    resource["kind"] = "executable"
        elif defect in WORKBOOK_VARIANTS:
            build_template(
                WORKBOOK_VARIANTS[defect], case_dir / "template.xlsx"
            )

        refresh_sizes(manifest, case_dir)
        write_json(case_dir / "manifest.json", manifest)
        zip_path = BASE / f"{case_name}.zip"
        zip_dir(case_dir, zip_path)
        if defect == "zip-path-traversal":
            with zipfile.ZipFile(zip_path, "a") as zf:
                info = zipfile.ZipInfo("../evil.txt", (2026, 1, 1, 0, 0, 0))
                zf.writestr(info, b"escaped\n")

        summary["cases"].append(
            {
                "case": case_name,
                "defect": defect,
                "zip": str(zip_path),
                "zipSize": zip_path.stat().st_size,
                "expectedError": defect,
            }
        )
        print(f"{case_name}: {zip_path.stat().st_size} bytes")

    write_json(BASE / "build.json", summary)
    print(f"F4: {len(CASES)} packages, real excerpt {duration} ms")


if __name__ == "__main__":
    main()
