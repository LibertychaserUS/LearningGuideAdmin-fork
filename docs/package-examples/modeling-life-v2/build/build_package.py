#!/usr/bin/env python3
"""Build the Modeling life v2 example package (full + lite).

One-command rebuild from the Owner's old zip:

  python3 -I build/build_package.py \
      --old-zip "/path/Modeling life内容文件.zip" \
      --repo "/path/to/LearningGuideAdmin"

Outputs:
  <pkg>/lite/modeling-life-v2-lite.lgcourse.zip    (committed, small)
  <pkg>/full/modeling-life-v2-full.lgcourse.zip    (gitignored, real media)
  <pkg>/full/package/                              (gitignored, extracted)

The builder is the single source of truth for the example package. It only
reads the old content package and the two checked-in content data files; it
never imports product code. Red lines enforced here:

  * no time column in the template (times live only in SRT / MP4 chapter track);
  * no sha256 / checksum / digest anywhere (package identity is
    (formatVersion, courseKey, versionNo); integrity = ZIP CRC32 + size);
  * no environment UUID; every asset key is a semantic stable key;
  * closed package: manifest.resources and the archive entries are 1:1.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

COURSE_KEY = "modeling-life"
PACKAGE_ID = "pkg_modeling-life_v1"
VERSION_NO = 1
CATEGORY_PATH = ["Science"]
LANGUAGES = ["en-GB", "zh-CN"]
STUDY_MODE = "both"
EXPORTED_AT = "2026-11-13T00:00:00Z"
EXPORTED_BY = "demo-operator@example.com"
PLAN_ID = "plan/modeling-life/content-v1/target-default/v1"
PLAN_VERSION = 1
APPROVAL_REF = "APR-DEMO-0001"
AUDIT_SUMMARY_REF = "audit/modeling-life/v1.json"
TIMING_RULE_VERSION = "timing-rules-v1"

LESSON_CODES = ["L001", "L002"]
LESSON_ORDER = {"L001": 1, "L002": 2}
# content.modeling-life.json uses L1/L2; the package uses the stable L001/L002.
SOURCE_LESSON_CODE = {"L001": "L1", "L002": "L2"}

JUNK_PREFIXES = ("__MACOSX/",)
JUNK_NAMES = {".DS_Store"}

# Exhibit code -> (assetKey, source kind, source path). Image exhibits only.
IMAGE_EXHIBITS = {
    "L001": [
        ("1.1", "ex-l1-01", "docx", "image1.png"),
        ("1.2", "ex-l1-02", "pkg", "lesson1-exhibit-1.png"),
        ("1.4", "ex-l1-04", "pkg", "lesson1-exhibit-2.png"),
        ("1.6", "ex-l1-06", "docx", "image4.png"),
        ("1.7", "ex-l1-07", "docx", "image5.png"),
        ("1.8", "ex-l1-08", "docx", "image6.png"),
        ("1.9", "ex-l1-09", "docx", "image7.png"),
        ("1.11", "ex-l1-11", "docx", "image8.png"),
        ("1.12", "ex-l1-12", "docx", "image9.png"),
        ("1.15", "ex-l1-15", "docx", "image10.png"),
        ("1.16", "ex-l1-16", "docx", "image11.png"),
        ("1.17", "ex-l1-17", "docx", "image12.png"),
    ],
    "L002": [
        ("2.1", "ex-l2-01", "docx", "image1.png"),
        ("2.2", "ex-l2-02", "docx", "image2.png"),
        ("2.3", "ex-l2-03", "docx", "image3.png"),
        ("2.4", "ex-l2-04", "docx", "image4.png"),
        ("2.5", "ex-l2-05", "docx", "image5.png"),
        ("2.6", "ex-l2-06", "docx", "image6.png"),
        ("2.7", "ex-l2-07", "docx", "image7.png"),
        ("2.8", "ex-l2-08", "docx", "image8.png"),
        ("2.9", "ex-l2-09", "docx", "image9.png"),
        ("2.10", "ex-l2-10", "docx", "image10.png"),
        ("2.11", "ex-l2-11", "docx", "image11.png"),
        ("2.12", "ex-l2-12", "docx", "image12.png"),
        ("2.13", "ex-l2-13", "docx", "image13.png"),
        ("2.14", "ex-l2-14", "docx", "image14.png"),
        ("2.15", "ex-l2-15", "docx", "image15.png"),
        ("2.16", "ex-l2-16", "docx", "image16.png"),
        ("2.17", "ex-l2-17", "docx", "image17.png"),
    ],
}
TEXT_EXHIBITS = {"L001": ["1.3", "1.5", "1.10", "1.13", "1.14", "1.18"]}

# assetKey -> package path. Videos and docs are filled with per-build copies.
THUMBNAILS = [
    ("L001", "1.2", "ex-l1-02-thumb", "pkg", "lesson1-exhibit1缩略图.png",
     "media/thumbnails/l1-02.png"),
    ("L001", "1.4", "ex-l1-04-thumb", "pkg", "lesson1-exhibit2缩略图.png",
     "media/thumbnails/l1-04.png"),
]
DOC_FILES = {
    "L001": ("l1-doc", "Lesson 1 文本课件.docx"),
    "L002": ("l2-doc", "Lesson 2文本课件.docx"),
}
VIDEO_FILES = {
    "L001": ("l1-video", "Lesson 1视频课件.mp4"),
    "L002": ("l2-video", "Lesson 2视频课件.mp4"),
}

HEADING_RE = re.compile(r"^(\d+\.\d+)\s+(.+)$")
EXHIBIT_RE = re.compile(r"^(?:Exhibit|展品)\s*(\d+\.\d+)\s+(.+)$")
CJK_RE = re.compile(r"[一-鿿]")


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------

def log(message: str) -> None:
    print(message, flush=True)


def run(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=True, text=True, **kwargs)


def ffprobe_duration_ms(path: Path) -> int:
    """Probe MP4 duration exactly like the compiler's probeMp4DurationMs.

    The compiler reads moov/mvhd and ceil()s duration*1000/timescale; using
    ffprobe's rounded format.duration can differ by 1 ms and make a frozen
    endMs fail ALN-7 validation. Keep the two probes identical.
    """
    import struct

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
    version = data[payload]
    if version == 1:
        timescale = struct.unpack_from(">I", data, payload + 20)[0]
        duration = struct.unpack_from(">Q", data, payload + 24)[0]
    else:
        timescale = struct.unpack_from(">I", data, payload + 12)[0]
        duration = struct.unpack_from(">I", data, payload + 16)[0]
    if timescale <= 0 or duration <= 0:
        raise SystemExit(f"invalid mvhd duration in {path}")
    import math
    return math.ceil(duration * 1000 / timescale)


def ffmpeg(args: list[str]) -> None:
    run(["ffmpeg", "-y", "-v", "error", *args])


def fixed_zip_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if not (info.flag_bits & 0x800):
        try:
            name = name.encode("cp437").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return name.replace("\\", "/")


def is_junk(name: str) -> bool:
    if any(name.startswith(prefix) for prefix in JUNK_PREFIXES):
        return True
    base = name.rsplit("/", 1)[-1]
    return base in JUNK_NAMES or base.startswith("~$")


def extract_old_package(zip_path: Path, work_dir: Path) -> dict[str, Path]:
    """Extract the old package with cp437→utf-8 names fixed; return real files."""
    out_dir = work_dir / "old"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    extracted: dict[str, Path] = {}
    names: list[str] = []
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            name = fixed_zip_name(info)
            if info.is_dir() or is_junk(name):
                continue
            names.append(name)
    # The Owner's zip nests everything under one top-level folder; strip it so
    # the builder addresses files by their delivered names.
    prefix = ""
    if names and all("/" in name for name in names):
        first = names[0].split("/", 1)[0]
        if all(name.split("/", 1)[0] == first for name in names):
            prefix = first + "/"
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            name = fixed_zip_name(info)
            if info.is_dir() or is_junk(name):
                continue
            relative = name[len(prefix):] if name.startswith(prefix) else name
            target = out_dir / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(info))
            extracted[relative] = target
    return extracted


def docx_paragraphs(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml").decode("utf-8")
    out: list[str] = []
    for match in re.finditer(r"<w:p[ >].*?</w:p>", xml, re.S):
        text = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", match.group(0), re.S))
        text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        text = " ".join(text.split())
        if text:
            out.append(text)
    return out


# ---------------------------------------------------------------------------
# Minimal xlsx reader (stdlib; used for the old workbook and for verification)
# ---------------------------------------------------------------------------

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _cell_column(ref: str) -> int:
    letters = "".join(ch for ch in ref if ch.isalpha())
    index = 0
    for ch in letters:
        index = index * 26 + (ord(ch.upper()) - ord("A") + 1)
    return index - 1


def read_xlsx(path: Path) -> dict[str, list[list[str]]]:
    with zipfile.ZipFile(path) as archive:
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
                    column = _cell_column(cell.get("r", "A1"))
                    value = cell.find(NS + "v")
                    text = None if value is None else (value.text or "")
                    if text is not None and cell.get("t") == "s":
                        text = shared[int(text)]
                    values[column] = text if text is not None else ""
                width = max(values) + 1 if values else 0
                rows.append([values.get(i, "") for i in range(width)])
            result[name] = rows
        return result


# ---------------------------------------------------------------------------
# Content model
# ---------------------------------------------------------------------------

def load_content(build_dir: Path) -> tuple[dict, dict]:
    content = json.loads((build_dir / "content.modeling-life.json").read_text("utf-8"))
    zh = json.loads((build_dir / "content.zh-demo.json").read_text("utf-8"))
    return content, zh


def normalized_lessons(content: dict) -> dict[str, dict]:
    by_source = {lesson["code"]: lesson for lesson in content["lessons"]}
    return {code: by_source[SOURCE_LESSON_CODE[code]] for code in LESSON_CODES}


def lesson_titles(content: dict) -> dict[str, dict]:
    out = {}
    for code, lesson in normalized_lessons(content).items():
        out[code] = {
            "en": lesson["titleEn"],
            "zh": lesson["titleZh"],
            "descEn": lesson["descEn"],
            "descZh": lesson["descZh"],
        }
    return out


def lp_rows(content: dict) -> dict[str, list[dict]]:
    out = {}
    for code, lesson in normalized_lessons(content).items():
        out[code] = [
            {"code": lp["code"], "en": lp["titleEn"], "zh": lp["titleZh"]}
            for lp in lesson["learningPoints"]
        ]
    return out


def exhibit_rows(content: dict) -> dict[str, list[dict]]:
    out = {}
    for code, lesson in normalized_lessons(content).items():
        out[code] = [
            {"code": ex["code"], "en": ex["titleEn"], "zh": ex["titleZh"]}
            for ex in lesson["exhibits"]
        ]
    return out


def parse_old_template(data: dict[str, list[list[str]]]) -> dict:
    """Extract KT/AT/reading rows from the old v1 template matrices."""
    kt: list[dict] = []
    for row in data.get("Knowledge test", [])[3:]:
        if not any(str(cell).strip() for cell in row):
            continue
        cells = [str(cell).strip() for cell in row] + [""] * 7
        if not cells[0].startswith("L"):
            continue
        kt.append({
            "lesson": cells[0],
            "order": int(float(cells[2])),
            "q": cells[3],
            "a": cells[4],
        })
    at: list[dict] = []
    for row in data.get("Application test", [])[3:]:
        if not any(str(cell).strip() for cell in row):
            continue
        cells = [str(cell).strip() for cell in row] + [""] * 6
        if not cells[0].startswith("L"):
            continue
        at.append({"lesson": cells[0], "q": cells[2], "a": cells[3]})
    readings: list[dict] = []
    for row in data.get("Reading list", [])[3:]:
        if not any(str(cell).strip() for cell in row):
            continue
        cells = [str(cell).strip() for cell in row] + [""] * 6
        if not cells[0].startswith("L"):
            continue
        readings.append({
            "lesson": cells[0],
            "type": cells[2],
            "title": cells[3],
            "author": cells[4],
            "why": cells[5],
        })
    return {"kt": kt, "at": at, "readings": readings}


def parse_old_lessons(data: dict[str, list[list[str]]]) -> dict[str, list[str]]:
    """Learning-point codes per lesson from the old v1 Lessons sheet."""
    codes: dict[str, list[str]] = {}
    current: str | None = None
    for raw_row in data.get("Lessons", []):
        row = [str(cell).strip() for cell in raw_row] + [""] * 7
        if row[0] == "Lesson ID" and row[1].startswith("L"):
            current = row[1]
            codes.setdefault(current, [])
        if current is None:
            continue
        for cell in row[:5]:
            if re.fullmatch(r"\d+\.\d+", cell) and cell not in codes[current]:
                codes[current].append(cell)
    return codes


def assert_content_matches_source(
    content: dict,
    old_parsed: dict,
    old_template: dict[str, list[list[str]]],
    docx_paragraphs_by_lesson: dict[str, list[str]],
    old_workbook: dict[str, list[list[str]]],
) -> None:
    """Cross-check the normalized bilingual titles against the old sources.

    The normalized JSON is the merge of the old xlsx (English) and the old docx
    (Chinese); this guard makes a silent drift visible instead of rebuilding a
    package whose titles no longer match the delivered content.
    """
    lessons = normalized_lessons(content)
    if len(old_parsed["kt"]) != 26:
        raise SystemExit(f"expected 26 knowledge-test rows in the old template, got {len(old_parsed['kt'])}")
    if len(old_parsed["at"]) != 2:
        raise SystemExit("expected 2 application-test rows in the old template")

    # Course identity from the old course workbook.
    course_rows = old_workbook.get("course info", [])
    flattened = {str(cell).strip() for row in course_rows for cell in row}
    if content["titleEn"] not in flattened:
        raise SystemExit("normalized course title does not match the old course workbook")
    if CATEGORY_PATH[0] not in flattened:
        raise SystemExit("normalized category does not match the old course workbook")

    # Learning-point codes from the old template.
    old_lp = parse_old_lessons(old_template)
    for code in LESSON_CODES:
        expected = [lp["code"] for lp in lessons[code]["learningPoints"]]
        actual = old_lp.get(code, [])
        if not set(expected).issubset(set(actual)):
            raise SystemExit(
                f"{code} learning-point codes drifted: expected {expected}, old template has {actual}"
            )

    # Every exhibit title must appear verbatim in the lesson docx.
    for code in LESSON_CODES:
        paragraphs = set(docx_paragraphs_by_lesson[code])
        for exhibit in lessons[code]["exhibits"]:
            english = f"Exhibit {exhibit['code']} {exhibit['titleEn']}"
            chinese = f"展品 {exhibit['code']} {exhibit['titleZh']}"
            if english not in paragraphs and chinese not in paragraphs:
                raise SystemExit(
                    f"{code} exhibit {exhibit['code']} title not found in the old docx"
                )


# ---------------------------------------------------------------------------
# Time sources
# ---------------------------------------------------------------------------

def build_srt_cues(
    paragraphs: list[str],
    lp_titles: dict[str, str],
    exhibit_titles: dict[str, str],
    duration_ms: int,
    *,
    lp_only: bool = False,
) -> list[tuple[int, int, str]]:
    """Build cue text in document order, then distribute inside real duration.

    Mirrors server/test/fixtures/longrange/scripts/build_subtitles.py: cue text
    is the lesson's own material; the timestamps are evenly distributed inside
    the probed duration (placeholder times, not hand-authored times).
    """
    texts: list[str] = []
    seen: set[str] = set()
    if lp_only:
        for title in lp_titles.values():
            if title not in seen:
                texts.append(title)
                seen.add(title)
    else:
        lp_codes = set(lp_titles)
        for text in paragraphs:
            match = HEADING_RE.match(text)
            if match and match.group(1) in lp_codes:
                title = lp_titles[match.group(1)]
                if title not in seen:
                    texts.append(title)
                    seen.add(title)
                continue
            match = EXHIBIT_RE.match(text)
            if match and match.group(1) in exhibit_titles:
                title = exhibit_titles[match.group(1)]
                if title not in seen:
                    texts.append(title)
                    seen.add(title)
                continue
            if CJK_RE.search(text):
                continue
            if HEADING_RE.match(text) or EXHIBIT_RE.match(text):
                continue
            if any(title.lower() in text.lower() for title in lp_titles.values()):
                continue
            if len(text) < 2:
                continue
            texts.append(text)

    if not texts:
        raise SystemExit("no cues constructed")

    margin = 200 if lp_only else 2000
    usable = duration_ms - margin * 2
    if usable <= len(texts) * 500:
        raise SystemExit(f"duration {duration_ms} ms too short for {len(texts)} cues")
    step = usable / len(texts)
    cues: list[tuple[int, int, str]] = []
    for index, text in enumerate(texts):
        start = margin + int(index * step)
        end = margin + int((index + 1) * step) - 1
        if index == len(texts) - 1:
            end = margin + usable
        if end - start < 500:
            end = start + 500
        cues.append((start, min(end, duration_ms), text))
    return cues


def srt_stamp(ms: int) -> str:
    hours, rem = divmod(ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def write_srt(path: Path, cues: list[tuple[int, int, str]]) -> None:
    blocks = []
    for index, (start, end, text) in enumerate(cues, start=1):
        blocks.append(f"{index}\n{srt_stamp(start)} --> {srt_stamp(end)}\n{text}\n")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(blocks), encoding="utf-8")


def parse_srt(path: Path) -> list[tuple[int, int, str]]:
    def stamp(token: str) -> int:
        hms, millis = token.split(",")
        hours, minutes, seconds = (int(part) for part in hms.split(":"))
        return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + int(millis)

    cues = []
    for block in re.split(r"\n\s*\n", path.read_text(encoding="utf-8").strip()):
        lines = block.strip().splitlines()
        if len(lines) < 3:
            continue
        start_text, end_text = [part.strip() for part in lines[1].split("-->")]
        cues.append((stamp(start_text), stamp(end_text), " ".join(lines[2:]).strip()))
    return cues


def chapter_metadata(duration_ms: int, titles: list[str]) -> str:
    if len(titles) == 2:
        starts = [0, duration_ms // 2]
    else:
        starts = [0]
    lines = [";FFMETADATA1"]
    for index, title in enumerate(titles):
        start = starts[index]
        end = starts[index + 1] - 1 if index + 1 < len(starts) else duration_ms
        lines += [
            "[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}",
            f"title={title}",
        ]
    return "\n".join(lines) + "\n"


def inject_chapters(video: Path, chapter_file: Path, out: Path) -> None:
    ffmpeg([
        "-i", str(video), "-f", "ffmetadata", "-i", str(chapter_file),
        "-map", "0", "-map_metadata", "1", "-map_chapters", "1",
        "-c", "copy", str(out),
    ])


def make_lite_video(source: Path, out: Path, seconds: int = 15) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg([
        "-i", str(source), "-t", str(seconds),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
        "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", str(out),
    ])


# ---------------------------------------------------------------------------
# Workbook payload
# ---------------------------------------------------------------------------

def build_workbook_payload(
    content: dict, zh: dict, old_parsed: dict, media_rows: list[list],
) -> dict[str, list[list]]:
    lessons = lesson_titles(content)
    lps = lp_rows(content)
    exhibits = exhibit_rows(content)

    meta = [[2, COURSE_KEY, ",".join(LANGUAGES), STUDY_MODE]]

    course_info = []
    course = content
    for field, en_key, zh_key in [
        ("title", "titleEn", "titleZh"),
        ("shortDescription", "shortDescriptionEn", "shortDescriptionZh"),
        ("overview", "overviewEn", "overviewZh"),
        ("whatYouLearn", "whatYouLearnEn", "whatYouLearnZh"),
        ("provides", "providesEn", "providesZh"),
    ]:
        course_info.append([field, "en-GB", course[en_key]])
        course_info.append([field, "zh-CN", course[zh_key]])

    lesson_rows = []
    for code in LESSON_CODES:
        lesson_rows.append([code, LESSON_ORDER[code], "en-GB", lessons[code]["en"], lessons[code]["descEn"]])
        lesson_rows.append([code, LESSON_ORDER[code], "zh-CN", lessons[code]["zh"], lessons[code]["descZh"]])

    learning_points = []
    for code in LESSON_CODES:
        for lp in lps[code]:
            learning_points.append([code, lp["code"], "en-GB", lp["en"]])
            learning_points.append([code, lp["code"], "zh-CN", lp["zh"]])

    exhibit_sheet = []
    for code in LESSON_CODES:
        for ex in exhibits[code]:
            is_text = ex["code"] in TEXT_EXHIBITS.get(code, [])
            asset = None
            if not is_text:
                asset = next(
                    (key for item_code, key, _, _ in IMAGE_EXHIBITS[code] if item_code == ex["code"]),
                    None,
                )
            for language, title_key in (("en-GB", "en"), ("zh-CN", "zh")):
                description = None
                if is_text:
                    description = zh["textExhibitDescriptions"][ex["code"]][title_key]
                exhibit_sheet.append([
                    code, ex["code"], "text" if is_text else "image",
                    asset, language, ex[title_key], description, None,
                ])

    reading_rows = []
    type_map = {"book": "book", "article": "article", "paper": "paper", "other": "other"}
    for record in old_parsed["readings"]:
        reading_rows.append([
            record["lesson"], type_map.get(record["type"].strip().lower(), "other"),
            record["title"], record["author"] or None, record["why"] or None,
        ])

    zh_kt = zh["knowledgeTestZh"]
    knowledge_rows = []
    for record in old_parsed["kt"]:
        knowledge_rows.append([record["lesson"], record["order"], "en-GB", record["q"], record["a"]])
    for record in old_parsed["kt"]:
        translated = zh_kt[record["lesson"]][record["order"] - 1]
        knowledge_rows.append([record["lesson"], record["order"], "zh-CN", translated["question"], translated["reference_answer"]])

    zh_at = zh["applicationTestZh"]
    application_rows = []
    for record in old_parsed["at"]:
        application_rows.append([record["lesson"], "en-GB", record["q"], record["a"]])
    for record in old_parsed["at"]:
        translated = zh_at[record["lesson"]]
        application_rows.append([record["lesson"], "zh-CN", translated["question"], translated["reference_answer"]])

    return {
        "Meta": meta,
        "Media": media_rows,
        "Course Info": course_info,
        "Lessons": lesson_rows,
        "Learning Points": learning_points,
        "Exhibits": exhibit_sheet,
        "Reading List": reading_rows,
        "Knowledge Test": knowledge_rows,
        "Application Test": application_rows,
    }


# ---------------------------------------------------------------------------
# Package assembly
# ---------------------------------------------------------------------------

def media_specs() -> list[dict]:
    """Ordered Media sheet rows (merged with manifest resources later)."""
    specs = [
        {"asset_key": "modeling-life-cover", "kind": "cover", "lesson": None,
         "language": None, "path": "media/cover.png", "thumbnail_of": None,
         "source": "课程封面.png"},
        {"asset_key": "l1-video", "kind": "video", "lesson": "L001",
         "language": "en-GB", "path": "media/videos/l1.mp4", "thumbnail_of": None,
         "source": VIDEO_FILES["L001"][1]},
        {"asset_key": "l2-video", "kind": "video", "lesson": "L002",
         "language": "en-GB", "path": "media/videos/l2.mp4", "thumbnail_of": None,
         "source": VIDEO_FILES["L002"][1]},
        {"asset_key": "l1-subtitle", "kind": "subtitle", "lesson": "L001",
         "language": "en-GB", "path": "subtitles/L001.en-GB.srt",
         "thumbnail_of": None, "source": None},
        {"asset_key": "l1-doc", "kind": "lesson-text", "lesson": "L001",
         "language": "en-GB", "path": "lessons/L001.docx", "thumbnail_of": None,
         "source": DOC_FILES["L001"][1]},
        {"asset_key": "l2-doc", "kind": "lesson-text", "lesson": "L002",
         "language": "en-GB", "path": "lessons/L002.docx", "thumbnail_of": None,
         "source": DOC_FILES["L002"][1]},
    ]
    for lesson in LESSON_CODES:
        for code, asset_key, source_kind, source_name in IMAGE_EXHIBITS[lesson]:
            number = code.split(".")[-1].zfill(2)
            specs.append({
                "asset_key": asset_key, "kind": "image", "lesson": lesson,
                "language": None,
                "path": f"media/exhibits/l{lesson[-1]}-{number}.png",
                "thumbnail_of": None, "source": source_name,
                "source_kind": source_kind, "exhibit_code": code,
            })
    for lesson, exhibit_code, asset_key, source_kind, source_name, path in THUMBNAILS:
        specs.append({
            "asset_key": asset_key, "kind": "thumbnail", "lesson": lesson,
            "language": None, "path": path,
            "thumbnail_of": next(
                key for item_code, key, _, _ in IMAGE_EXHIBITS[lesson]
                if item_code == exhibit_code
            ),
            "source": source_name, "source_kind": source_kind,
            "exhibit_code": exhibit_code,
        })
    return specs


def media_sheet_rows(specs: list[dict]) -> list[list]:
    rows = []
    for spec in specs:
        rows.append([
            spec["asset_key"], spec["kind"], spec["lesson"], spec["language"],
            spec["path"], spec["thumbnail_of"],
        ])
    return rows


def copy_media(specs: list[dict], old: dict[str, Path], docx_images: dict[str, dict[str, Path]], staging: Path) -> None:
    for spec in specs:
        target = staging / spec["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if spec["asset_key"] in ("l1-video", "l2-video", "l1-subtitle"):
            continue  # written by the video/subtitle stage
        if spec["asset_key"] in ("l1-doc", "l2-doc"):
            lesson = spec["lesson"]
            source = old[DOC_FILES[lesson][1]]
            shutil.copyfile(source, target)
            continue
        if spec["kind"] == "cover":
            shutil.copyfile(old[spec["source"]], target)
            continue
        if spec["kind"] in ("image", "thumbnail"):
            if spec.get("source_kind") == "docx":
                lesson = spec["lesson"]
                shutil.copyfile(docx_images[lesson][spec["source"]], target)
            else:
                shutil.copyfile(old[spec["source"]], target)
            continue
        raise SystemExit(f"unhandled media spec {spec}")


def extract_docx_images(old: dict[str, Path], work_dir: Path) -> dict[str, dict[str, Path]]:
    """Extract every embedded PNG from the two lesson docx files."""
    out: dict[str, dict[str, Path]] = {}
    for lesson in LESSON_CODES:
        docx = old[DOC_FILES[lesson][1]]
        target_dir = work_dir / "docx-images" / lesson
        if target_dir.exists():
            shutil.rmtree(target_dir)
        target_dir.mkdir(parents=True)
        files: dict[str, Path] = {}
        with zipfile.ZipFile(docx) as archive:
            for name in archive.namelist():
                match = re.fullmatch(r"word/media/(image\d+\.png)", name)
                if not match:
                    continue
                target = target_dir / match.group(1)
                target.write_bytes(archive.read(name))
                files[match.group(1)] = target
        out[lesson] = files
    return out


def build_renditions(
    content: dict, specs: list[dict], lesson_timing: dict[str, dict[str, tuple[int, int]]],
) -> list[dict]:
    lps = lp_rows(content)
    renditions: list[dict] = []

    def add(rendition: dict) -> None:
        renditions.append(rendition)

    for lesson in LESSON_CODES:
        anchor = "subtitle" if lesson == "L001" else "chapter"
        carrier = "l1-video" if lesson == "L001" else "l2-video"
        for lp in lps[lesson]:
            start, end = lesson_timing[lesson][lp["code"]]
            add({
                "renditionKey": f"r.{lesson}.video.en-GB.video.asset.{carrier}.lp.{lp['code']}",
                "contentKey": lesson,
                "blockId": "video",
                "language": "en-GB",
                "modality": "video",
                "occurrenceKey": f"lp.{lp['code']}",
                "carrierType": "asset",
                "carrierKey": carrier,
                "carrierVersion": 1,
                "startMs": start,
                "endMs": end,
                "anchorSource": anchor,
                "revision": 1,
            })
        doc_key = "l1-doc" if lesson == "L001" else "l2-doc"
        add({
            "renditionKey": f"r.{lesson}.body.en-GB.text.document.{doc_key}.body",
            "contentKey": lesson,
            "blockId": "body",
            "language": "en-GB",
            "modality": "text",
            "occurrenceKey": "body",
            "carrierType": "document",
            "carrierKey": doc_key,
            "carrierVersion": 1,
            "anchorSource": "doc-structure",
            "revision": 1,
        })
        for ex in exhibit_rows(content)[lesson]:
            if ex["code"] in TEXT_EXHIBITS.get(lesson, []):
                continue
            asset = next(
                key for item_code, key, _, _ in IMAGE_EXHIBITS[lesson]
                if item_code == ex["code"]
            )
            for language in LANGUAGES:
                add({
                    "renditionKey": f"r.{lesson}.{ex['code']}.{language}.image.asset.{asset}.main",
                    "contentKey": lesson,
                    "blockId": ex["code"],
                    "language": language,
                    "modality": "image",
                    "occurrenceKey": "main",
                    "carrierType": "asset",
                    "carrierKey": asset,
                    "carrierVersion": 1,
                    "anchorSource": "import-legacy",
                    "revision": 1,
                })
        for thumbnail in THUMBNAILS:
            if thumbnail[0] != lesson:
                continue
            _, exhibit_code, asset_key, _, _, _ = thumbnail
            for language in LANGUAGES:
                add({
                    "renditionKey": f"r.{lesson}.{exhibit_code}.{language}.image.asset.{asset_key}.thumbnail",
                    "contentKey": lesson,
                    "blockId": exhibit_code,
                    "language": language,
                    "modality": "image",
                    "occurrenceKey": "thumbnail",
                    "carrierType": "asset",
                    "carrierKey": asset_key,
                    "carrierVersion": 1,
                    "anchorSource": "import-legacy",
                    "revision": 1,
                })
    return renditions


def build_alignments(content: dict, lesson_timing: dict[str, dict[str, tuple[int, int]]]) -> list[dict]:
    lps = lp_rows(content)
    alignments: list[dict] = []
    verified_by = "demo-operator@example.com"
    verified_at = "2026-11-13T00:00:00Z"

    def add(entry: dict) -> None:
        alignments.append(entry)

    for lesson in LESSON_CODES:
        objective = f"obj-{lps[lesson][0]['code']}"
        anchor = "subtitle" if lesson == "L001" else "chapter"
        artifact = "subtitles/L001.en-GB.srt" if lesson == "L001" else "media/videos/l2.mp4"
        carrier = "l1-video" if lesson == "L001" else "l2-video"
        for lp in lps[lesson]:
            add({
                "alignmentId": f"aln-{lesson}-{lp['code']}",
                "stageKey": f"lesson-{lesson.lower()}",
                "renditionKey": f"r.{lesson}.video.en-GB.video.asset.{carrier}.lp.{lp['code']}",
                "objectiveKey": f"obj-{lp['code']}",
                "role": "primary",
                "status": "verified",
                "provenance": "human",
                "sourceKind": anchor,
                "sourceArtifact": artifact,
                "ruleVersion": TIMING_RULE_VERSION,
                "verifiedBy": verified_by,
                "verifiedAt": verified_at,
                "verifiedAgainst": {"renditionRevision": 1, "carrierVersion": 1, "specVersion": 1},
            })
        doc_key = "l1-doc" if lesson == "L001" else "l2-doc"
        add({
            "alignmentId": f"aln-{lesson}-body",
            "stageKey": f"lesson-{lesson.lower()}",
            "renditionKey": f"r.{lesson}.body.en-GB.text.document.{doc_key}.body",
            "objectiveKey": objective,
            "role": "support",
            "status": "verified",
            "provenance": "human",
            "sourceKind": "doc-structure",
            "sourceArtifact": doc_key,
            "ruleVersion": TIMING_RULE_VERSION,
            "verifiedBy": verified_by,
            "verifiedAt": verified_at,
            "verifiedAgainst": {"renditionRevision": 1, "carrierVersion": 1, "specVersion": 1},
        })
        for ex in exhibit_rows(content)[lesson]:
            if ex["code"] in TEXT_EXHIBITS.get(lesson, []):
                continue
            asset = next(
                key for item_code, key, _, _ in IMAGE_EXHIBITS[lesson]
                if item_code == ex["code"]
            )
            for language in LANGUAGES:
                add({
                    "alignmentId": f"aln-{lesson}-{ex['code']}-{language}",
                    "stageKey": f"lesson-{lesson.lower()}",
                    "renditionKey": f"r.{lesson}.{ex['code']}.{language}.image.asset.{asset}.main",
                    "objectiveKey": objective,
                    "role": "auxiliary",
                    "status": "verified",
                    "provenance": "human",
                    "verifiedBy": verified_by,
                    "verifiedAt": verified_at,
                    "verifiedAgainst": {"renditionRevision": 1, "carrierVersion": 1, "specVersion": 1},
                })
    return alignments


def build_manifest(
    content: dict,
    specs: list[dict],
    staging: Path,
    lesson_timing: dict[str, dict[str, tuple[int, int]]],
    *,
    variant: str,
    duration_ms: dict[str, int],
) -> dict:
    lps = lp_rows(content)
    resources = [{
        "id": "template", "kind": "template", "path": "template.xlsx",
        "size": (staging / "template.xlsx").stat().st_size,
    }]
    for spec in specs:
        path = staging / spec["path"]
        if not path.exists():
            raise SystemExit(f"resource missing on disk: {path}")
        resources.append({
            "id": spec["asset_key"],
            "kind": "document" if spec["kind"] == "lesson-text" else spec["kind"],
            "path": spec["path"],
            "size": path.stat().st_size,
        })

    stages = [{
        "courseKey": COURSE_KEY,
        "stageKey": "program-modeling-life",
        "parentStageKey": None,
        "orderKey": "000001",
        "kind": "program",
        "goal": "Modeling life",
        "objectiveKeys": [],
        "exitEvidence": [],
        "exitRollup": {"kind": "all"},
        "status": "active",
    }]
    for index, lesson in enumerate(LESSON_CODES, start=1):
        stage_key = f"lesson-{lesson.lower()}"
        objectives = [f"obj-{lp['code']}" for lp in lps[lesson]]
        stages.append({
            "courseKey": COURSE_KEY,
            "stageKey": stage_key,
            "parentStageKey": "program-modeling-life",
            "orderKey": f"000001.{index:06d}",
            "kind": "step",
            "goal": lesson_titles(content)[lesson]["en"],
            "objectiveKeys": objectives,
            "exitEvidence": [f"ev-{lesson.lower()}-kt", f"ev-{lesson.lower()}-at"],
            "exitRollup": {"kind": "all"},
            "durationBudget": duration_ms[lesson],
            "status": "active",
        })

    evidence_specs = []
    for lesson in LESSON_CODES:
        objectives = [f"obj-{lp['code']}" for lp in lps[lesson]]
        evidence_specs.append({
            "evidenceKey": f"ev-{lesson.lower()}-kt",
            "version": 1,
            "kind": "artifact",
            "objectiveKeys": objectives,
            "measure": {
                "kind": "artifact",
                "instructions": f"Submit written answers to the {lesson} knowledge test.",
            },
            "scoring": "pass-fail",
            "threshold": 1,
            "attempts": 2,
        })
        evidence_specs.append({
            "evidenceKey": f"ev-{lesson.lower()}-at",
            "version": 1,
            "kind": "artifact",
            "objectiveKeys": objectives,
            "measure": {
                "kind": "artifact",
                "instructions": f"Submit a written solution to the {lesson} application problem.",
            },
            "scoring": "pass-fail",
            "threshold": 1,
            "attempts": 2,
        })

    spec_pins = []
    for lesson in LESSON_CODES:
        for suffix in ("", ".reading", ".knowledge-test", ".application-test"):
            spec_pins.append({"contentKey": f"{lesson}{suffix}", "version": 1})

    asset_pins = [
        {"assetKey": spec["asset_key"], "assetVersion": 1}
        for spec in specs
        if spec["kind"] != "template"
    ]

    renditions = build_renditions(content, specs, lesson_timing)
    alignments = build_alignments(content, lesson_timing)

    exhibit_count = sum(len(exhibit_rows(content)[lesson]) for lesson in LESSON_CODES)
    text_exhibit_count = sum(len(TEXT_EXHIBITS.get(lesson, [])) for lesson in LESSON_CODES)
    manifest = {
        "format": "lg-course-package",
        "formatVersion": 2,
        "packageId": PACKAGE_ID,
        "exportedAt": EXPORTED_AT,
        "minReaderVersion": 2,
        "extensionsUsed": [],
        "extensionsRequired": [],
        "course": {
            "courseKey": COURSE_KEY,
            "titleLocalized": {
                "en-GB": {"title": content["titleEn"]},
                "zh-CN": {"title": content["titleZh"]},
            },
            "categoryPath": CATEGORY_PATH,
            "learningLanguages": LANGUAGES,
            "studyMode": STUDY_MODE,
        },
        "content": {
            "courseKey": COURSE_KEY,
            "versionNo": VERSION_NO,
            "categoryPath": CATEGORY_PATH,
            "stages": stages,
            "prerequisiteEdges": [{
                "fromStageKey": "lesson-l001",
                "toStageKey": "lesson-l002",
                "kind": "requires",
            }],
            "specPins": spec_pins,
            "renditions": renditions,
            "alignments": alignments,
            "evidenceSpecs": evidence_specs,
            "assetPins": asset_pins,
        },
        "resources": resources,
        "provenance": {
            "sourceEnv": "sandbox",
            "sourceVersionLabel": "1.0",
            "exportedAt": EXPORTED_AT,
            "exportedBy": EXPORTED_BY,
            "courseKey": COURSE_KEY,
            "planPin": {"planId": PLAN_ID, "planVersion": PLAN_VERSION},
            "approvalRef": APPROVAL_REF,
            "auditSummaryRef": AUDIT_SUMMARY_REF,
        },
        "annotations": {
            "generatedBy": "modeling-life-v2 example builder",
            "demo": True,
            "variant": variant,
            "legacySource": "Modeling life内容文件.zip",
            "sourceEnv": "sandbox",
            "sourceLabel": "Sandbox 1.0",
            "timingSources": ["subtitle", "chapter"],
            "contentCounts": {
                "lessons": 2,
                "learningPoints": 7,
                "exhibits": exhibit_count,
                "textExhibits": text_exhibit_count,
                "knowledgeTests": 26,
                "applicationTests": 2,
                "readings": 6,
            },
            "demoValues": {
                "planPin": "demo-only plan reference; not a real signed plan",
                "approvalRef": "demo-only approval reference; not a real approval record",
                "auditSummaryRef": "demo-only audit summary reference",
                "verifiedAlignments": (
                    "verifiedBy/verifiedAt are demo operator values. Times come from "
                    "the package's own SRT (L001) and MP4 chapter track (L002); they "
                    "are machine-derived demo sources, not ASR-verified ground truth."
                ),
                "zhCnText": (
                    "zh-CN Knowledge Test / Application Test rows and the six text "
                    "exhibit bodies are demo-authored (not machine translation) and "
                    "pending content-team review."
                ),
            },
            "learningPointTitlesZh": {
                code: [{"code": lp["code"], "title": lp["zh"]} for lp in lps[code]]
                for code in LESSON_CODES
            },
            "verification": [
                {
                    "kind": "timing-audit",
                    "lessonCode": "L001",
                    "sourceKind": "subtitle",
                    "sourceArtifact": "subtitles/L001.en-GB.srt",
                    "modelVersion": None,
                    "params": None,
                    "ruleVersion": TIMING_RULE_VERSION,
                    "verifiedBy": EXPORTED_BY,
                    "verifiedAt": EXPORTED_AT,
                },
                {
                    "kind": "timing-audit",
                    "lessonCode": "L002",
                    "sourceKind": "chapter",
                    "sourceArtifact": "media/videos/l2.mp4",
                    "modelVersion": None,
                    "params": None,
                    "ruleVersion": TIMING_RULE_VERSION,
                    "verifiedBy": EXPORTED_BY,
                    "verifiedAt": EXPORTED_AT,
                },
            ],
            "mediaSpecNotes": [
                "Source images/docx are delivered as-is; the builder never upscales "
                "or rewrites teaching media (media is an input, C0 red line 5).",
                "Lite package only: videos are shortened to 15 s so the example can "
                "live in git; full package keeps the real 165 MB media.",
            ],
        },
    }
    return manifest


def zip_package(staging: Path, out_zip: Path) -> None:
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(
        path for path in staging.rglob("*")
        if path.is_file() and path.name != "manifest.json"
    )
    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        info = zipfile.ZipInfo("manifest.json", date_time=(2026, 11, 13, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (staging / "manifest.json").read_bytes())
        for path in files:
            relative = path.relative_to(staging).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(2026, 11, 13, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())


# ---------------------------------------------------------------------------
# Build one variant
# ---------------------------------------------------------------------------

def build_variant(
    *,
    variant: str,
    staging: Path,
    content: dict,
    zh: dict,
    old_parsed: dict,
    old: dict[str, Path],
    docx_images: dict[str, dict[str, Path]],
    workbook_script: Path,
    server_dir: Path,
    build_dir: Path,
) -> tuple[Path, dict, dict[str, int]]:
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    specs = media_specs()

    # 1) Copy documents, cover and images (untouched teaching assets).
    copy_media(specs, old, docx_images, staging)

    # 2) Videos: full = real; lite = 15 s. L002 always gets an injected chapter
    #    track (the demo of "chapter" as a machine time source).
    duration_ms: dict[str, int] = {}
    for lesson in LESSON_CODES:
        asset_key, source_name = VIDEO_FILES[lesson]
        target = staging / f"media/videos/l{lesson[-1]}.mp4"
        target.parent.mkdir(parents=True, exist_ok=True)
        source = old[source_name]
        if variant == "full":
            shutil.copyfile(source, target)
        else:
            make_lite_video(source, target)
        duration_ms[lesson] = ffprobe_duration_ms(target)

    lesson_titles_map = {code: lp_rows(content)[code] for code in LESSON_CODES}

    # 3) L002 chapter track (ffmpeg injects a mov_text chapter track; streams
    #    are copied for full, lite is already a fresh encode).
    chapter_file = staging / "chapters.meta.txt"
    chapter_file.write_text(
        chapter_metadata(duration_ms["L002"], [lp["en"] for lp in lesson_titles_map["L002"]]),
        encoding="utf-8",
    )
    video_path = staging / "media/videos/l2.mp4"
    chaptered = staging / "media/videos/l2-chaptered.mp4"
    inject_chapters(video_path, chapter_file, chaptered)
    chaptered.replace(video_path)
    chapter_file.unlink()
    duration_ms["L002"] = ffprobe_duration_ms(video_path)

    # 4) L001 external subtitle (SRT). Full uses the whole docx script; lite
    #    uses the learning-point titles only so cues still fit 15 s.
    paragraphs = docx_paragraphs(old[DOC_FILES["L001"][1]])
    lp_titles_en = {lp["code"]: lp["en"] for lp in lesson_titles_map["L001"]}
    exhibit_titles_en = {ex["code"]: ex["en"] for ex in exhibit_rows(content)["L001"]}
    cues = build_srt_cues(
        paragraphs, lp_titles_en, exhibit_titles_en, duration_ms["L001"],
        lp_only=(variant != "full"),
    )
    write_srt(staging / "subtitles/L001.en-GB.srt", cues)

    # 5) Timing table used by the manifest (machine-derived values only).
    cue_by_title = {text: (start, end) for start, end, text in parse_srt(staging / "subtitles/L001.en-GB.srt")}
    lesson_timing: dict[str, dict[str, tuple[int, int]]] = {}
    lesson_timing["L001"] = {}
    for lp in lesson_titles_map["L001"]:
        if lp["en"] not in cue_by_title:
            raise SystemExit(f"L001 subtitle has no cue for {lp['code']}: {lp['en']}")
        lesson_timing["L001"][lp["code"]] = cue_by_title[lp["en"]]
    half = duration_ms["L002"] // 2
    lesson_timing["L002"] = {
        "2.1": (0, half - 1),
        "2.2": (half, duration_ms["L002"]),
    }
    for lesson, entries in lesson_timing.items():
        for code, (start, end) in entries.items():
            if not (0 <= start < end <= duration_ms[lesson]):
                raise SystemExit(f"invalid timing for {lesson} {code}: {start},{end}")

    # 6) Template workbook.
    payload = build_workbook_payload(content, zh, old_parsed, media_sheet_rows(specs))
    payload_path = build_dir / f".workbook-{variant}.json"
    payload_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    run([
        "node", str(workbook_script), "--in", str(payload_path),
        "--out", str(staging / "template.xlsx"), "--server-dir", str(server_dir),
    ], cwd=str(server_dir))
    payload_path.unlink()

    # 7) Manifest (sizes are read from the final files).
    manifest = build_manifest(
        content, specs, staging, lesson_timing,
        variant=variant, duration_ms=duration_ms,
    )
    (staging / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    return staging, manifest, duration_ms


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-zip", required=True)
    parser.add_argument("--old-template", default=None,
                        help="old v1 content template xlsx (defaults to the repo copy)")
    parser.add_argument("--repo", default=None)
    parser.add_argument("--work-dir", default="/tmp/modeling-life-v2-build")
    parser.add_argument("--full-dir", default=None)
    parser.add_argument("--lite-dir", default=None)
    parser.add_argument("--skip-full", action="store_true")
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    package_dir = script_dir.parent
    if args.repo:
        repo = Path(args.repo).resolve()
    else:
        repo = package_dir.parents[2]
    server_dir = repo / "server"
    if not (server_dir / "node_modules" / "xlsx").exists():
        raise SystemExit(f"xlsx not installed under {server_dir}/node_modules")
    workbook_script = script_dir / "build_workbook.mjs"

    content, zh = load_content(script_dir)
    old_zip = Path(args.old_zip).expanduser().resolve()
    if not old_zip.exists():
        raise SystemExit(f"old package not found: {old_zip}")

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    log(f"extracting old package: {old_zip}")
    old = extract_old_package(old_zip, work_dir)
    log(f"  {len(old)} content files")

    if args.old_template:
        template_path = Path(args.old_template)
    else:
        # Checked-in copy keeps the rebuild self-contained; fall back to docs/.
        local_template = script_dir / "legacy" / "Course_Content_Template_modeling_life.xlsx"
        template_path = local_template if local_template.exists() else (
            repo / "docs" / "Course_Content_Template_modeling_life.xlsx"
        )
    if not template_path.exists():
        raise SystemExit(f"old v1 template not found: {template_path}")
    old_template = read_xlsx(template_path)
    old_parsed = parse_old_template(old_template)
    old_workbook = read_xlsx(old["modeling life课程信息.xlsx"])
    docx_paras = {
        code: docx_paragraphs(old[DOC_FILES[code][1]]) for code in LESSON_CODES
    }
    assert_content_matches_source(
        content, old_parsed, old_template, docx_paras, old_workbook,
    )
    log(f"old template: {len(old_parsed['kt'])} KT, {len(old_parsed['at'])} AT, "
        f"{len(old_parsed['readings'])} readings")

    docx_images = extract_docx_images(old, work_dir)
    log(f"docx images: {sum(len(v) for v in docx_images.values())}")

    full_dir = Path(args.full_dir) if args.full_dir else package_dir / "full"
    lite_dir = Path(args.lite_dir) if args.lite_dir else package_dir / "lite"

    # Lite first (cheap) so a failure is fast.
    lite_staging = work_dir / "staging-lite"
    _, lite_manifest, _ = build_variant(
        variant="lite", staging=lite_staging, content=content, zh=zh,
        old_parsed=old_parsed, old=old, docx_images=docx_images,
        workbook_script=workbook_script, server_dir=server_dir, build_dir=script_dir,
    )
    lite_zip = lite_dir / "modeling-life-v2-lite.lgcourse.zip"
    zip_package(lite_staging, lite_zip)
    log(f"lite package -> {lite_zip} ({lite_zip.stat().st_size} bytes)")

    if not args.skip_full:
        full_staging = work_dir / "staging-full"
        _, full_manifest, _ = build_variant(
            variant="full", staging=full_staging, content=content, zh=zh,
            old_parsed=old_parsed, old=old, docx_images=docx_images,
            workbook_script=workbook_script, server_dir=server_dir, build_dir=script_dir,
        )
        full_zip = full_dir / "modeling-life-v2-full.lgcourse.zip"
        zip_package(full_staging, full_zip)
        extracted = full_dir / "package"
        if extracted.exists():
            shutil.rmtree(extracted)
        shutil.copytree(full_staging, extracted)
        log(f"full package -> {full_zip} ({full_zip.stat().st_size} bytes)")
    else:
        log("full package skipped (--skip-full)")


if __name__ == "__main__":
    main()
