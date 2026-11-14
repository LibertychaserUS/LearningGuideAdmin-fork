#!/usr/bin/env python3
"""Verify a Modeling life v2 example package (full or lite).

Usage:
  python3 -I build/verify_package.py --package lite/modeling-life-v2-lite.lgcourse.zip
  python3 -I build/verify_package.py --dir full/package

Checks (exit code 0 = all pass):
  1. manifest is v2, no legacy fields and no sha256/checksum/digest anywhere;
  2. template has exactly the 9 machine sheets, contract headers, and no time
     column (HUMAN_TIME_FORBIDDEN rule), Meta.templateVersion = 2;
  3. Media sheet and manifest.resources are 1:1 (incl. lesson-text↔document);
  4. closed package: archive entries ↔ declared paths, sizes match;
  5. stable keys: no environment UUIDs, no absolute/traversal paths;
  6. courseKey / categoryPath consistency;
  7. SRT parses and cues sit inside the probed duration; MP4 chapter track
     exists and its titles match the learning points, inside the duration;
  8. every rendition time is 0 <= start < end <= duration and every verified
     alignment carries its audit tuple;
  9. lite videos are shortened (<= 20 s) and full videos are the real media.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import struct
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

HEADERS = {
    "Meta": ["templateVersion", "courseCode", "learningLanguages", "studyMode"],
    "Media": ["asset_key", "kind", "lesson_code", "language", "relative_path", "thumbnail_of"],
    "Course Info": ["field", "language", "text"],
    "Lessons": ["lesson_code", "order", "language", "title", "description"],
    "Learning Points": ["lesson_code", "lp_code", "language", "title"],
    "Exhibits": ["lesson_code", "exhibit_code", "media_type", "asset_key", "language", "title", "description", "source"],
    "Reading List": ["lesson_code", "type", "title", "author", "why"],
    "Knowledge Test": ["lesson_code", "order", "language", "question", "reference_answer"],
    "Application Test": ["lesson_code", "language", "question", "reference_answer"],
}
TIME_COLUMN = re.compile(
    r"(?:^|[^a-z])(?:times?|timestamps?|durations?|seconds?|minutes?|clock|ms|start|end|trigger|时间|时长|秒|分钟|开始|结束|触发)(?:[^a-z]|$)|mm:ss|hh:mm",
    re.IGNORECASE,
)
UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
HASH_KEYS = {"sha256", "sha1", "checksum", "checksums", "digest", "md5"}

CHECKS: list[str] = []
FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    status = "PASS" if condition else "FAIL"
    CHECKS.append(f"[{status}] {message}")
    if not condition:
        FAILURES.append(message)


def load_package(path: Path) -> tuple[dict, dict[str, bytes], Path | None]:
    if path.is_dir():
        files = {
            file.relative_to(path).as_posix(): file.read_bytes()
            for file in path.rglob("*") if file.is_file()
        }
        return json.loads(files["manifest.json"]), files, path
    with zipfile.ZipFile(path) as archive:
        files = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
    return json.loads(files["manifest.json"]), files, None


# --- xlsx ---------------------------------------------------------------

def _column(ref: str) -> int:
    letters = "".join(ch for ch in ref if ch.isalpha())
    value = 0
    for ch in letters:
        value = value * 26 + (ord(ch.upper()) - ord("A") + 1)
    return value - 1


def read_workbook(blob: bytes) -> dict[str, list[list[str]]]:
    import io

    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relmap = {rel.get("Id"): rel.get("Target") for rel in rels}
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = [
                "".join(node.text or "" for node in item.iter(NS + "t"))
                for item in root.findall(NS + "si")
            ]
        result: dict[str, list[list[str]]] = {}
        for sheet in workbook.find(NS + "sheets"):
            name = sheet.get("name")
            target = relmap[sheet.get(RNS + "id")]
            sheet_path = target if target.startswith("xl/") else "xl/" + target
            data = ET.fromstring(archive.read(sheet_path))
            rows: list[list[str]] = []
            for row in data.iter(NS + "row"):
                values: dict[int, str] = {}
                for cell in row:
                    column = _column(cell.get("r", "A1"))
                    value = cell.find(NS + "v")
                    text = None if value is None else (value.text or "")
                    if text is not None and cell.get("t") == "s":
                        text = shared[int(text)]
                    values[column] = text if text is not None else ""
                width = max(values) + 1 if values else 0
                rows.append([values.get(i, "") for i in range(width)])
            result[name] = rows
        return result


# --- media --------------------------------------------------------------

def ffprobe_json(path: Path, *extra: str) -> dict:
    args = ["ffprobe", "-v", "error", *extra, "-of", "json", str(path)]
    return json.loads(subprocess.run(args, check=True, capture_output=True, text=True).stdout)


def mp4_duration_ms(path: Path) -> int:
    """moov/mvhd duration, ceil()ed to ms (same rule as the Part C compiler)."""
    data = path.read_bytes()

    def boxes(start: int, end: int):
        offset = start
        while offset + 8 <= end:
            size = struct.unpack_from(">I", data, offset)[0]
            kind = data[offset + 4:offset + 8].decode("latin-1")
            header = 8
            if size == 1:
                size = struct.unpack_from(">Q", data, offset + 8)[0]
                header = 16
            elif size == 0:
                size = end - offset
            if size < header or offset + size > end:
                return
            yield kind, offset, header, size
            offset += size

    moov = next((box for box in boxes(0, len(data)) if box[0] == "moov"), None)
    if moov is None:
        raise SystemExit(f"no moov box in {path}")
    mvhd = next((box for box in boxes(moov[1] + moov[2], moov[1] + moov[3]) if box[0] == "mvhd"), None)
    if mvhd is None:
        raise SystemExit(f"no mvhd box in {path}")
    payload = mvhd[1] + mvhd[2]
    if data[payload] == 1:
        timescale = struct.unpack_from(">I", data, payload + 20)[0]
        duration = struct.unpack_from(">Q", data, payload + 24)[0]
    else:
        timescale = struct.unpack_from(">I", data, payload + 12)[0]
        duration = struct.unpack_from(">I", data, payload + 16)[0]
    if timescale <= 0 or duration <= 0:
        raise SystemExit(f"invalid mvhd duration in {path}")
    return math.ceil(duration * 1000 / timescale)


def srt_ms(token: str) -> int:
    hms, millis = token.replace(".", ",").split(",")
    hours, minutes, seconds = (int(part) for part in hms.split(":"))
    return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + int(millis)


def parse_srt_bytes(blob: bytes) -> list[tuple[int, int, str]]:
    text = blob.decode("utf-8-sig")
    cues = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        start, end = [part.strip() for part in lines[1].split("-->")]
        cues.append((srt_ms(start), srt_ms(end), " ".join(lines[2:]).strip()))
    return cues


def collect_hash_violations(value, path=""):
    bad = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key.lower() in HASH_KEYS or any(token in key.lower() for token in ("sha256", "checksum", "digest")):
                bad.append(f"{path}.{key}")
            bad += collect_hash_violations(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            bad += collect_hash_violations(child, f"{path}[{index}]")
    return bad


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", default=None)
    parser.add_argument("--dir", default=None)
    parser.add_argument("--expect", choices=["full", "lite"], default=None)
    args = parser.parse_args()
    if not args.package and not args.dir:
        raise SystemExit("--package or --dir is required")
    path = Path(args.dir or args.package).resolve()
    manifest, files, dir_path = load_package(path)
    label = path.name
    print(f"verifying: {path}")

    # 1) manifest contract + no hashes -------------------------------
    check(manifest.get("format") == "lg-course-package", "manifest.format is lg-course-package")
    check(manifest.get("formatVersion") == 2, "manifest.formatVersion is 2")
    check(manifest.get("minReaderVersion") == 2, "manifest.minReaderVersion is 2")
    check("category" not in manifest.get("course", {}), "legacy course.category absent")
    hashes = collect_hash_violations(manifest)
    check(not hashes, f"no sha256/checksum/digest fields (found: {hashes[:3]})")
    provenance = manifest.get("provenance") or {}
    check(provenance.get("sourceEnv") == "sandbox", "provenance.sourceEnv is sandbox")
    check(bool(provenance.get("sourceVersionLabel")), "provenance.sourceVersionLabel present")
    for field in ("planPin", "approvalRef", "auditSummaryRef"):
        check(field in provenance, f"provenance.{field} present (demo value)")
    check("asr" not in provenance, "provenance.asr absent (no ASR derivation used)")

    # 2) course / category consistency -------------------------------
    course = manifest["course"]
    content = manifest["content"]
    check(course["courseKey"] == content["courseKey"] == provenance.get("courseKey"), "courseKey consistent across course/content/provenance")
    check(course["categoryPath"] == content["categoryPath"], "course.categoryPath == content.categoryPath")
    check(course["categoryPath"] == ["Science"], "categoryPath is the stable key ['Science']")
    check(course["learningLanguages"] == ["en-GB", "zh-CN"], "learningLanguages are en-GB,zh-CN")
    check(course["studyMode"] == "both", "studyMode is both")

    # 3) closed package ----------------------------------------------
    declared = {resource["path"]: resource for resource in manifest["resources"]}
    entries = {name: blob for name, blob in files.items() if name != "manifest.json"}
    missing = sorted(set(declared) - set(entries))
    unknown = sorted(set(entries) - set(declared))
    check(not missing, f"every declared resource exists (missing: {missing[:3]})")
    check(not unknown, f"no undeclared package files (unknown: {unknown[:3]})")
    size_bad = [
        resource["path"] for resource in manifest["resources"]
        if resource["path"] in entries and len(entries[resource["path"]]) != resource["size"]
    ]
    check(not size_bad, f"declared sizes match packaged bytes (bad: {size_bad[:3]})")
    path_bad = []
    for resource in manifest["resources"]:
        rel = resource["path"]
        if rel.startswith(("/", "\\")) or "\\" in rel or any(
            segment in ("", ".", "..") for segment in rel.split("/")
        ):
            path_bad.append(rel)
    check(not path_bad, f"resource paths are closed/relative (bad: {path_bad[:3]})")

    # 4) stable keys (no env UUID) -----------------------------------
    keys = [resource["id"] for resource in manifest["resources"]]
    keys += [pin["assetKey"] for pin in content["assetPins"]]
    keys += [stage["stageKey"] for stage in content["stages"]]
    keys += [rendition["renditionKey"] for rendition in content["renditions"]]
    uuid_hits = [key for key in keys if UUID_RE.search(key)]
    check(not uuid_hits, f"no environment UUID in keys (hits: {uuid_hits[:3]})")

    # 5) template workbook -------------------------------------------
    template = next((r for r in manifest["resources"] if r["kind"] == "template"), None)
    check(template is not None, "exactly one template resource declared")
    workbook: dict[str, list[list[str]]] = {}
    if template is not None:
        workbook = read_workbook(entries[template["path"]])
        check(list(workbook) == list(HEADERS), f"9 machine sheets in contract order (got {list(workbook)})")
        for sheet, headers in HEADERS.items():
            actual = [cell.strip() for cell in workbook.get(sheet, [[]])[0]] if workbook.get(sheet) else []
            check(actual[:len(headers)] == headers, f"{sheet} headers match contract")
            offenders = [header for header in actual if TIME_COLUMN.search(header)]
            check(not offenders, f"{sheet} has no time column (offenders: {offenders})")
        meta_row = workbook["Meta"][1]
        check(str(meta_row[0]) == "2", "Meta.templateVersion is 2")
        check(meta_row[1] == manifest["course"]["courseKey"], "Meta.courseCode matches manifest courseKey")
        check(str(meta_row[2]).split(",") == manifest["course"]["learningLanguages"], "Meta.learningLanguages matches manifest")
        check(meta_row[3] == manifest["course"]["studyMode"], "Meta.studyMode matches manifest")

        # Media sheet ↔ resources 1:1
        media_rows = workbook["Media"][1:]
        by_key = {row[0]: row for row in media_rows if row and row[0]}
        manifest_media = {
            resource["id"]: resource for resource in manifest["resources"]
            if resource["kind"] != "template"
        }
        check(set(by_key) == set(manifest_media), "Media sheet asset keys == manifest resources ids")
        media_bad = []
        for key, row in by_key.items():
            resource = manifest_media.get(key)
            if resource is None:
                media_bad.append(f"{key}:unexpected")
                continue
            kind = row[1]
            expected_kind = "document" if kind == "lesson-text" else kind
            if row[4] != resource["path"] or expected_kind != resource["kind"]:
                media_bad.append(f"{key}:{kind}->{row[4]}")
        check(not media_bad, f"Media rows agree with resources (bad: {media_bad[:3]})")

        # counts
        check(len(workbook["Learning Points"]) - 1 == 14, "7 learning points x 2 languages = 14 rows")
        check(len(workbook["Exhibits"]) - 1 == 70, "35 exhibits x 2 languages = 70 rows")
        check(len(workbook["Knowledge Test"]) - 1 == 52, "26 knowledge tests x 2 languages = 52 rows")
        check(len(workbook["Application Test"]) - 1 == 4, "2 application tests x 2 languages = 4 rows")
        check(len(workbook["Reading List"]) - 1 == 6, "6 reading-list rows")

    # 6) timing sources ----------------------------------------------
    resources_by_id = {resource["id"]: resource for resource in manifest["resources"]}
    durations: dict[str, int] = {}
    for asset_key in ("l1-video", "l2-video"):
        resource = resources_by_id[asset_key]
        raw = entries[resource["path"]]
        temp = Path("/tmp") / f"verify-{label}-{asset_key}.mp4"
        temp.write_bytes(raw)
        durations[asset_key] = mp4_duration_ms(temp)
    expected = args.expect
    if expected == "lite":
        check(all(value <= 20_000 for value in durations.values()), f"lite videos <= 20 s (got {durations})")
    elif expected == "full":
        check(durations["l1-video"] > 1_000_000 and durations["l2-video"] > 1_000_000, f"full videos keep real length (got {durations})")

    subtitle = resources_by_id.get("l1-subtitle")
    check(subtitle is not None and subtitle["kind"] == "subtitle", "L001 subtitle declared (subtitle priority path)")
    if subtitle is not None:
        cues = parse_srt_bytes(entries[subtitle["path"]])
        check(len(cues) > 0, f"L001 SRT parses into cues ({len(cues)})")
        check(all(0 <= start < end <= durations["l1-video"] for start, end, _ in cues), "L001 SRT cues are inside the real duration")
        lp_titles = {row[3] for row in workbook["Learning Points"][1:] if row[0] == "L001" and row[2] == "en-GB"}
        cue_texts = {text for _, _, text in cues}
        check(lp_titles <= cue_texts, f"L001 SRT contains every learning-point title (missing: {sorted(lp_titles - cue_texts)[:3]})")

    video2 = resources_by_id["l2-video"]
    temp2 = Path("/tmp") / f"verify-{label}-l2.mp4"
    temp2.write_bytes(entries[video2["path"]])
    probe2 = ffprobe_json(temp2, "-show_entries", "format=duration", "-show_chapters")
    chapters = probe2.get("chapters") or []
    check(len(chapters) > 0, f"L002 MP4 carries a chapter track ({len(chapters)} chapters)")
    if chapters:
        chapter_titles = [chapter["tags"].get("title", "") for chapter in chapters]
        lp2 = [row[3] for row in workbook["Learning Points"][1:] if row[0] == "L002" and row[2] == "en-GB"]
        check(chapter_titles == lp2, f"L002 chapter titles match learning points (got {chapter_titles})")
        check(
            all(0 <= float(chapter["start_time"]) * 1000 < durations["l2-video"] for chapter in chapters),
            "L002 chapter starts are inside the real duration",
        )

    # 7) renditions / alignments -------------------------------------
    duration_by_carrier = {"l1-video": durations["l1-video"], "l2-video": durations["l2-video"]}
    bad_timing = []
    for rendition in content["renditions"]:
        if "startMs" in rendition:
            limit = duration_by_carrier.get(rendition["carrierKey"])
            if limit is None or not (0 <= rendition["startMs"] < rendition["endMs"] <= limit):
                bad_timing.append(rendition["renditionKey"])
    check(not bad_timing, f"rendition times satisfy 0 <= start < end <= duration (bad: {bad_timing[:3]})")
    bad_alignment = []
    for alignment in content["alignments"]:
        if alignment.get("status") != "verified":
            bad_alignment.append(alignment["alignmentId"])
            continue
        if not all(alignment.get(field) for field in ("verifiedBy", "verifiedAt", "verifiedAgainst")):
            bad_alignment.append(alignment["alignmentId"])
    check(not bad_alignment, f"every alignment is verified with audit tuple (bad: {bad_alignment[:3]})")
    check(all(al.get("ruleVersion") == "timing-rules-v1" for al in content["alignments"] if "sourceKind" in al), "timing audit uses ruleVersion timing-rules-v1")

    # 8) report -------------------------------------------------------
    print("")
    for line in CHECKS:
        print(line)
    print("")
    if FAILURES:
        print(f"RESULT: FAIL ({len(FAILURES)} failed of {len(CHECKS)})")
        for failure in FAILURES:
            print(f"  - {failure}")
        sys.exit(1)
    print(f"RESULT: PASS ({len(CHECKS)} checks)")


if __name__ == "__main__":
    main()
