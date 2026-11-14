#!/usr/bin/env python3
"""Self-check every long-range fixture and print machine-readable evidence.

Black-box only: reads the fixture files, the nested template workbooks and
ffprobe output. Nothing from product code is imported.

Run: python3 -I scripts/verify_fixtures.py
Exit code 0 = all checks passed.
"""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_common import FIXTURE_ROOT, ffprobe_summary  # noqa: E402

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
VALID_RESOURCE_KINDS = {
    "template", "document", "cover", "video", "audio", "image", "model3d",
    "thumbnail", "lesson-text", "subtitle", "chapters",
}

failures: list[str] = []
checks: list[str] = []


def check(condition: bool, message: str) -> None:
    status = "PASS" if condition else "FAIL"
    checks.append(f"[{status}] {message}")
    if not condition:
        failures.append(message)


def sheet_path(x: zipfile.ZipFile, name: str) -> str:
    wb = ET.fromstring(x.read("xl/workbook.xml"))
    rels = ET.fromstring(x.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in rels}
    for sh in wb.find(NS + "sheets"):
        if sh.get("name") == name:
            target = relmap[sh.get(RNS + "id")]
            return target if target.startswith("xl/") else "xl/" + target
    raise KeyError(name)


def cell_column(ref: str) -> int:
    letters = "".join(ch for ch in ref if ch.isalpha())
    index = 0
    for ch in letters:
        index = index * 26 + (ord(ch.upper()) - ord("A") + 1)
    return index - 1


def workbook_rows(pkg: Path, sheet: str) -> list[list[str | None]]:
    with zipfile.ZipFile(pkg / "template.xlsx") as x:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in x.namelist():
            root = ET.fromstring(x.read("xl/sharedStrings.xml"))
            shared = [
                "".join(t.text or "" for t in si.iter(NS + "t"))
                for si in root.findall(NS + "si")
            ]
        data = ET.fromstring(x.read(sheet_path(x, sheet)))
        rows: list[list[str | None]] = []
        for row in data.iter(NS + "row"):
            values: dict[int, str | None] = {}
            for cell in row:
                column = cell_column(cell.get("r", "A1"))
                value = cell.find(NS + "v")
                text = None if value is None else value.text
                if text is not None and cell.get("t") == "s":
                    text = shared[int(text)]
                values[column] = text
            width = max(values) + 1 if values else 0
            rows.append([values.get(i) for i in range(width)])
        return rows


def last_cue_end_ms(path: Path) -> int:
    def to_ms(stamp: str) -> int:
        clock, frac = stamp.replace(".", ",").split(",")
        h, m, s = clock.split(":")
        return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(frac)

    ends = [
        to_ms(line.split(" --> ")[1])
        for line in path.read_text(encoding="utf-8").splitlines()
        if " --> " in line
    ]
    return max(ends)


def verify_manifest_package(name: str, timing_source: str,
                            subtitle_durations: dict[str, int]) -> dict:
    base = FIXTURE_ROOT / name
    pkg = base / "package"
    manifest = json.loads((pkg / "manifest.json").read_text(encoding="utf-8"))
    check(manifest["format"] == "lg-course-package", f"{name}: manifest format")
    check(manifest["formatVersion"] == 2, f"{name}: formatVersion=2")
    check(
        manifest["course"]["courseKey"] == manifest["content"]["courseKey"],
        f"{name}: courseKey consistent",
    )
    check(
        manifest["provenance"]["sourceEnv"] == "sandbox",
        f"{name}: provenance sandbox",
    )

    resources = manifest["resources"]
    paths = [r["path"] for r in resources]
    ids = [r["id"] for r in resources]
    check(len(paths) == len(set(paths)), f"{name}: resource paths unique")
    check(len(ids) == len(set(ids)), f"{name}: resource ids unique")
    for resource in resources:
        check(
            resource["kind"] in VALID_RESOURCE_KINDS,
            f"{name}: resource kind {resource['kind']} allowed",
        )
        file = pkg / resource["path"]
        check(file.exists(), f"{name}: resource exists {resource['path']}")
        if file.exists():
            check(
                file.stat().st_size == resource["size"],
                f"{name}: resource size matches {resource['path']}",
            )

    media_rows = workbook_rows(pkg, "Media")[1:]
    by_key = {
        row[0]: row
        for row in media_rows
        if row and row[0] is not None
    }
    declared = [r for r in resources if r["kind"] != "template"]
    for resource in declared:
        row = by_key.get(resource["id"])
        check(row is not None, f"{name}: Media row for {resource['id']}")
        if row is not None:
            kind_matches = row[1] == resource["kind"] or (
                row[1] == "lesson-text" and resource["kind"] == "document"
            )
            check(
                kind_matches and row[4] == resource["path"],
                f"{name}: Media row matches {resource['id']}",
            )
    check(
        len(by_key) == len(declared),
        f"{name}: Media rows == declared resources",
    )

    probes = {}
    for lesson in ("l1", "l2"):
        video = pkg / "media" / f"{lesson}-video.mp4"
        if video.exists():
            probes[lesson] = ffprobe_summary(video)
    if timing_source == "chapter":
        for lesson in ("l1", "l2"):
            check(
                probes[lesson]["chapters"] > 0,
                f"{name}: {lesson} carries a chapter track "
                f"({probes[lesson]['chapters']})",
            )
            check(
                probes[lesson]["subtitleStreams"] == 0,
                f"{name}: {lesson} has no embedded subtitle stream",
            )
        check(
            all(row[1] != "subtitle" for row in media_rows if row),
            f"{name}: no subtitle Media row (chapter source)",
        )
    else:
        for lesson, probe in probes.items():
            check(
                probe["chapters"] == 0,
                f"{name}: {lesson} has no chapter track (subtitle source)",
            )
            subtitle = pkg / "subtitles" / (
                "l1.en-GB.srt" if lesson == "l1" else "l2.en-GB.vtt"
            )
            check(subtitle.exists(), f"{name}: subtitle exists {subtitle.name}")
            if subtitle.exists():
                check(
                    last_cue_end_ms(subtitle) <= probe["durationMs"],
                    f"{name}: {lesson} subtitle cues within duration",
                )
        check(
            any(row[1] == "subtitle" for row in media_rows if row),
            f"{name}: Media sheet declares subtitles",
        )

    if name == "F5_replacement":
        check(
            probes["l1"]["durationMs"] != subtitle_durations.get("l1"),
            f"{name}: Lesson 1 duration changed "
            f"({probes['l1']['durationMs']} vs {subtitle_durations.get('l1')})",
        )
        pin = next(
            p for p in manifest["content"]["assetPins"]
            if p["assetKey"] == "l1-video"
        )
        check(pin["assetVersion"] == 2, f"{name}: l1-video assetVersion=2")
        check(
            manifest["content"]["versionNo"] == 2, f"{name}: content versionNo=2"
        )
    return probes


def verify_f4() -> None:
    base = FIXTURE_ROOT / "F4_bad_packages"
    cases = {
        "01-missing-manifest-field": "missing course.titleLocalized",
        "02-unknown-file": "undeclared media/orphan.bin",
        "03-version-missing": "formatVersion absent",
        "04-duplicate-truth-key": "duplicate LP truth key",
        "05-out-of-range-time": "cue beyond duration",
        "06-unknown-code": "Knowledge Test unknown lesson_code",
        "07-missing-language": "video row language null",
        "08-illegal-media-type": "resource kind executable",
        "09-zip-path-traversal": "zip entry ../evil.txt",
    }
    for case, description in cases.items():
        zip_path = base / f"{case}.zip"
        check(zip_path.exists(), f"F4 {case}: zip exists")
        if not zip_path.exists():
            continue
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            manifest = json.loads(z.read("manifest.json"))
            if case.startswith("01"):
                ok = "titleLocalized" not in manifest["course"]
            elif case.startswith("02"):
                declared = {r["path"] for r in manifest["resources"]}
                ok = "media/orphan.bin" in names and "media/orphan.bin" not in declared
            elif case.startswith("03"):
                ok = "formatVersion" not in manifest
            elif case.startswith("04"):
                rows = workbook_rows(zip_path.parent / case, "Learning Points")[1:]
                ok = len(rows) != len({tuple(r[:3]) for r in rows})
            elif case.startswith("05"):
                probe = ffprobe_summary(
                    zip_path.parent / case / "media" / "bad-video.mp4"
                )
                end = last_cue_end_ms(
                    zip_path.parent / case / "subtitles" / "BL1.en-GB.srt"
                )
                ok = end > probe["durationMs"]
            elif case.startswith("06"):
                rows = workbook_rows(zip_path.parent / case, "Knowledge Test")[1:]
                ok = any(r and r[0] == "NOPE" for r in rows)
            elif case.startswith("07"):
                rows = workbook_rows(zip_path.parent / case, "Media")[1:]
                ok = any(
                    r and r[0] == "bad-video" and (len(r) < 4 or not r[3])
                    for r in rows
                )
            elif case.startswith("08"):
                ok = any(
                    r["kind"] == "executable"
                    for r in manifest["resources"]
                    if r["id"] == "bad-video"
                )
            else:
                ok = any(name.startswith("../") for name in names)
            check(bool(ok), f"F4 {case}: {description}")


def main() -> None:
    inventory = json.loads(
        (FIXTURE_ROOT / "F1" / "inventory.json").read_text(encoding="utf-8")
    )
    check(inventory["hasSubtitles"] is False, "F1: no subtitle files in real zip")
    check(
        inventory["hasChapterTracks"] is False,
        "F1: no MP4 chapter tracks in real zip",
    )
    check(inventory["entryCount"] == 25, "F1: 25 zip entries inventoried")
    check(inventory["contentEntryCount"] == 11, "F1: 11 content entries")
    check(len(inventory["contentFiles"]) == 10, "F1: 10 content files")
    media = inventory["media"]
    check(len(media) == 2, "F1: two real videos")
    for probe in media:
        check(probe["durationMs"] > 60_000, f"F1: {probe['name']} real duration")

    f2 = verify_manifest_package("F2_subtitles", "subtitle", {})
    verify_manifest_package(
        "F3_chapters", "chapter", {"l1": f2["l1"]["durationMs"]}
    )
    verify_manifest_package(
        "F5_replacement", "subtitle", {"l1": f2["l1"]["durationMs"]}
    )
    verify_f4()

    print("\n".join(checks))
    print()
    print(f"summary: {len(checks) - len(failures)}/{len(checks)} checks passed")
    if failures:
        print("FAILURES:")
        for failure in failures:
            print(f"  - {failure}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
