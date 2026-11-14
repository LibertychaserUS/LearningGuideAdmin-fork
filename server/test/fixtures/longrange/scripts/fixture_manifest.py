#!/usr/bin/env python3
"""Build a Part C v2 manifest that matches a fixture package directory.

Contract source: docs/Course_Package_Spec_v2.md §3 and
server/src/partc/contracts/package-manifest.ts (shape only; nothing is
imported from product code).
"""
from __future__ import annotations

from pathlib import Path

from fixture_common import write_json

# path -> (asset/resource id, resource kind), in Media-sheet order.
MEDIA_SPECS = [
    ("media/cover.png", "modeling-life-cover", "cover"),
    ("media/l1-video.mp4", "l1-video", "video"),
    ("media/l2-video.mp4", "l2-video", "video"),
    ("subtitles/l1.en-GB.srt", "l1-subtitle", "subtitle"),
    ("subtitles/l2.en-GB.vtt", "l2-subtitle", "subtitle"),
    ("lessons/l1.docx", "l1-doc", "document"),
    ("lessons/l2.docx", "l2-doc", "document"),
    ("media/l1-ex1.png", "l1-ex1", "image"),
    ("media/l1-ex2.png", "l1-ex2", "image"),
    ("media/l1-ex1-thumb.png", "l1-ex1-thumb", "thumbnail"),
    ("media/l1-ex2-thumb.png", "l1-ex2-thumb", "thumbnail"),
]
TEMPLATE_SPEC = ("template.xlsx", "template", "template")


def specs_for(timing_source: str) -> list[tuple[str, str, str]]:
    specs = [TEMPLATE_SPEC]
    for spec in MEDIA_SPECS:
        if timing_source == "chapter" and spec[2] == "subtitle":
            continue
        specs.append(spec)
    return specs


def build_manifest(
    data: dict,
    pkg_dir: Path,
    specs: list[tuple[str, str, str]],
    *,
    version_no: int,
    l1_video_version: int,
    timing_sources: list[str],
    exported_at: str,
) -> dict:
    resources = []
    for path, resource_id, kind in specs:
        file = pkg_dir / path
        if not file.exists():
            raise SystemExit(f"resource missing on disk: {file}")
        resources.append(
            {
                "id": resource_id,
                "kind": kind,
                "path": path,
                "size": file.stat().st_size,
            }
        )

    asset_versions = {resource_id: 1 for _, resource_id, _ in specs}
    asset_versions["l1-video"] = l1_video_version
    asset_pins = [
        {"assetKey": resource_id, "assetVersion": asset_versions[resource_id]}
        for _, resource_id, kind in specs
        if kind != "template"
    ]

    stages = [
        {
            "courseKey": data["courseKey"],
            "stageKey": "program-modeling-life",
            "parentStageKey": None,
            "orderKey": "000001",
            "kind": "program",
            "goal": data["titleEn"],
            "objectiveKeys": [],
            "exitEvidence": [],
            "exitRollup": {"kind": "all"},
            "status": "active",
        }
    ]
    evidence_specs = []
    spec_pins = []
    for index, lesson in enumerate(data["lessons"], start=1):
        lesson_key = f"lesson-{index}"
        objectives = [f"obj-{index}"]
        evidence = [f"ev-{index}"]
        stages.append(
            {
                "courseKey": data["courseKey"],
                "stageKey": lesson_key,
                "parentStageKey": "program-modeling-life",
                "orderKey": f"000001.{index:06d}",
                "kind": "step",
                "goal": lesson["titleEn"],
                "objectiveKeys": objectives,
                "exitEvidence": evidence,
                "exitRollup": {"kind": "all"},
                "status": "active",
            }
        )
        evidence_specs.append(
            {
                "evidenceKey": f"ev-{index}",
                "version": 1,
                "kind": "artifact",
                "objectiveKeys": objectives,
                "measure": {
                    "kind": "artifact",
                    "instructions": (
                        f"Complete the artefact for {lesson['titleEn']}."
                    ),
                },
                "scoring": "pass-fail",
                "threshold": 1,
                "attempts": 1,
            }
        )
        spec_pins.append({"contentKey": lesson_key, "version": 1})

    manifest = {
        "format": "lg-course-package",
        "formatVersion": 2,
        "packageId": f"pkg_{data['courseKey']}_v{version_no}",
        "exportedAt": exported_at,
        "minReaderVersion": 2,
        "extensionsUsed": [],
        "extensionsRequired": [],
        "course": {
            "courseKey": data["courseKey"],
            "titleLocalized": {
                "en-GB": {"title": data["titleEn"]},
                "zh-CN": {"title": data["titleZh"]},
            },
            "categoryPath": data["categoryPath"],
            "learningLanguages": data["learningLanguages"],
            "studyMode": data["studyMode"],
        },
        "content": {
            "courseKey": data["courseKey"],
            "versionNo": version_no,
            "categoryPath": data["categoryPath"],
            "stages": stages,
            "prerequisiteEdges": [],
            "specPins": spec_pins,
            "renditions": [],
            "alignments": [],
            "evidenceSpecs": evidence_specs,
            "assetPins": asset_pins,
        },
        "resources": resources,
        "provenance": {
            "sourceEnv": "sandbox",
            "sourceVersionLabel": "1.0",
            "exportedAt": exported_at,
            "exportedBy": "fixtures@example.com",
            "courseKey": data["courseKey"],
            "planPin": {
                "planId": (
                    f"plan/{data['courseKey']}/content-v{version_no}/"
                    "target-default/v1"
                ),
                "planVersion": 1,
            },
            "approvalRef": f"APPROVED-FIXTURE-v{version_no}",
            "auditSummaryRef": f"audit/{data['courseKey']}/v{version_no}.json",
        },
        "annotations": {
            "generatedBy": "longrange-fixture-builder",
            "timingSources": timing_sources,
            "lessonCodes": [lesson["code"] for lesson in data["lessons"]],
        },
    }
    return manifest


def write_manifest(pkg_dir: Path, manifest: dict) -> None:
    write_json(pkg_dir / "manifest.json", manifest)
