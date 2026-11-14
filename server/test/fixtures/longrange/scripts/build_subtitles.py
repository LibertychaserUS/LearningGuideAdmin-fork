#!/usr/bin/env python3
"""Generate parseable SRT/VTT subtitles for one lesson from the real docx.

Cues are the lesson's own content, in document order:
  * learning-point headings  -> cue text is the LP title (exactly once)
  * exhibit lines            -> cue text is the exhibit title
  * English dialogue/prose   -> filler cue text (never contains an LP title,
                                so LP-title cue matching stays unambiguous)

Time cues are evenly distributed across the *real* container duration (the
subtitle values are placeholders; they are not hand-authored times). The output
is a normal SRT/VTT file that the compiler's parser accepts.

Usage:
  python3 -I build_subtitles.py --data data/course_content.json \
    --lesson L1 --duration-ms 1469312 --format srt --out F2/subtitles/l1.en-GB.srt
"""
from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_common import FIXTURE_ROOT  # noqa: E402

F1_PKG = FIXTURE_ROOT / "F1" / "package" / "Modeling life内容文件"
DOCX = {
    "L1": F1_PKG / "Lesson 1 文本课件.docx",
    "L2": F1_PKG / "Lesson 2文本课件.docx",
}
HEADING_RE = re.compile(r"^(\d+\.\d+)\s+(.+)$")
EXHIBIT_RE = re.compile(r"^(?:Exhibit|展品)\s*(\d+\.\d+)\s+(.+)$")
CJK_RE = re.compile(r"[一-鿿]")


def paragraphs(docx: Path) -> list[str]:
    with zipfile.ZipFile(docx) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    out: list[str] = []
    for match in re.finditer(r"<w:p[ >].*?</w:p>", xml, re.S):
        text = "".join(
            re.findall(r"<w:t[^>]*>(.*?)</w:t>", match.group(0), re.S)
        )
        text = (
            text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        )
        text = " ".join(text.split())
        if text:
            out.append(text)
    return out


def fmt_srt(ms: int) -> str:
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{milli:03d}"


def fmt_vtt(ms: int) -> str:
    return fmt_srt(ms).replace(",", ".")


def build_cues(lesson: dict, duration_ms: int) -> list[str]:
    lp_titles = [lp["titleEn"] for lp in lesson["learningPoints"]]
    exhibit_titles = {
        ex["code"]: ex["titleEn"] for ex in lesson["exhibits"]
    }

    raw = paragraphs(DOCX[lesson["code"]])
    texts: list[str] = []
    seen_title: set[str] = set()
    lp_codes = {lp["code"] for lp in lesson["learningPoints"]}
    for text in raw:
        # Headings/exhibits are recognized first: the real docx carries some
        # headings only in Chinese, but the English LP title is authoritative.
        m = HEADING_RE.match(text)
        if m and m.group(1) in lp_codes:
            title = next(
                lp["titleEn"]
                for lp in lesson["learningPoints"]
                if lp["code"] == m.group(1)
            )
            if title not in seen_title:
                texts.append(title)
                seen_title.add(title)
            continue
        m = EXHIBIT_RE.match(text)
        if m and m.group(1) in exhibit_titles:
            exhibit_title = exhibit_titles[m.group(1)]
            if exhibit_title not in seen_title:
                texts.append(exhibit_title)
                seen_title.add(exhibit_title)
            continue
        if CJK_RE.search(text):
            continue
        if HEADING_RE.match(text) or EXHIBIT_RE.match(text):
            continue
        # Filler dialogue/prose: drop anything that would collide with an LP title.
        if any(title.lower() in text.lower() for title in lp_titles):
            continue
        if len(text) < 2:
            continue
        texts.append(text)

    if not texts:
        raise SystemExit(f"no cues constructed for {lesson['code']}")

    margin = 2000
    usable = duration_ms - margin * 2
    if usable <= len(texts) * 500:
        raise SystemExit("duration too short for the generated cue count")
    step = usable / len(texts)
    cues = []
    for index, text in enumerate(texts):
        start = margin + int(index * step)
        end = margin + int((index + 1) * step) - 1
        if index == len(texts) - 1:
            end = margin + usable
        if end - start < 500:
            end = start + 500
        cues.append((start, min(end, duration_ms), text))
    return cues


def render(cues, fmt: str) -> str:
    lines: list[str] = []
    if fmt == "vtt":
        lines.append("WEBVTT")
        lines.append("")
    stamp = fmt_vtt if fmt == "vtt" else fmt_srt
    for index, (start, end, text) in enumerate(cues, start=1):
        if fmt == "srt":
            lines.append(str(index))
        lines.append(f"{stamp(start)} --> {stamp(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--lesson", required=True, choices=["L1", "L2"])
    parser.add_argument("--duration-ms", required=True, type=int)
    parser.add_argument("--format", required=True, choices=["srt", "vtt"])
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    import json

    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    lesson = next(l for l in data["lessons"] if l["code"] == args.lesson)
    cues = build_cues(lesson, args.duration_ms)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(cues, args.format), encoding="utf-8")
    print(
        f"{args.lesson} {args.format}: {len(cues)} cues, "
        f"{args.duration_ms} ms -> {out}"
    )


if __name__ == "__main__":
    main()
