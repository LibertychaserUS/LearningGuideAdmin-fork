#!/usr/bin/env python3
"""Derive the fixture course model from the real docx files (F1 package).

Produces `data/course_content.json`, the single source of truth shared by the
workbook builder (Node), the subtitle generator (Python) and the manifest
builder (Python). Everything here comes from the extracted F1 package:
lesson headings (LP codes/titles), exhibit lines, and the course title.

Run: python3 -I scripts/build_course_data.py
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixture_common import FIXTURE_ROOT, write_json  # noqa: E402

F1_PKG = FIXTURE_ROOT / "F1" / "package" / "Modeling life内容文件"
DATA_DIR = FIXTURE_ROOT / "data"

DOCX = {
    "L1": F1_PKG / "Lesson 1 文本课件.docx",
    "L2": F1_PKG / "Lesson 2文本课件.docx",
}

HEADING_RE = re.compile(r"^(\d+\.\d+)\s+(.+)$")
EXHIBIT_RE = re.compile(r"^(?:Exhibit|展品)\s*(\d+\.\d+)\s+(.+)$")
ZH_RE = re.compile(r"[一-鿿]")

XLSX = F1_PKG / "modeling life课程信息.xlsx"
SS_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


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
        ).strip()
        if text:
            out.append(text)
    return out


def lessons_sheet_lp_titles() -> dict[str, str]:
    """LP code -> English title, from the real `Lessons` sheet (authoritative)."""
    with zipfile.ZipFile(XLSX) as z:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall(f"{SS_NS}si"):
                shared.append(
                    "".join(t.text or "" for t in si.iter(f"{SS_NS}t")).strip()
                )
        sheet = ET.fromstring(z.read("xl/worksheets/sheet2.xml"))
        titles: dict[str, str] = {}
        for row in sheet.iter(f"{SS_NS}row"):
            for cell in row:
                if not str(cell.get("r", "")).startswith("B"):
                    continue
                value = cell.find(f"{SS_NS}v")
                if value is None or value.text is None:
                    continue
                text = value.text
                if cell.get("t") == "s":
                    text = shared[int(text)]
                m = HEADING_RE.match(text.strip())
                if m and not ZH_RE.search(m.group(2)):
                    titles.setdefault(m.group(1), m.group(2).strip())
        return titles


def main() -> None:
    lessons = []
    lesson_meta = {
        "L1": {
            "titleEn": "State Spaces, Vector Spaces and Trajectories",
            "titleZh": "状态空间、向量空间与轨迹",
            "descEn": "A system can be thought of as a collection of states at different times.",
            "descZh": "系统可以被看作不同时刻状态的集合。",
            "order": 1,
        },
        "L2": {
            "titleEn": "Pitchfork Bifurcation",
            "titleZh": "叉式分岔",
            "descEn": "A new model and a new kind of bifurcation.",
            "descZh": "一个新模型和一种新的分岔。",
            "order": 2,
        },
    }

    sheet_titles = lessons_sheet_lp_titles()

    for code, docx in DOCX.items():
        if not docx.exists():
            raise SystemExit(f"missing docx: {docx}")
        paras = paragraphs(docx)
        lps: dict[str, dict[str, str]] = {}
        exhibits: dict[str, dict[str, str]] = {}
        for text in paras:
            m = HEADING_RE.match(text)
            if m and len(m.group(2)) < 120:
                lp_code, title = m.group(1), m.group(2).strip()
                slot = lps.setdefault(lp_code, {})
                if ZH_RE.search(title):
                    slot.setdefault("titleZh", title)
                else:
                    slot.setdefault("titleEn", title)
                continue
            m = EXHIBIT_RE.match(text)
            if m:
                ex_code, title = m.group(1), m.group(2).strip()
                slot = exhibits.setdefault(ex_code, {})
                if ZH_RE.search(title):
                    slot.setdefault("titleZh", title)
                else:
                    slot.setdefault("titleEn", title)

        meta = lesson_meta[code]
        lesson = {
            "code": code,
            "order": meta["order"],
            "titleEn": meta["titleEn"],
            "titleZh": meta["titleZh"],
            "descEn": meta["descEn"],
            "descZh": meta["descZh"],
            "learningPoints": [
                {
                    "code": lp_code,
                    "titleEn": sheet_titles.get(
                        lp_code,
                        value.get("titleEn", value.get("titleZh", "")),
                    ),
                    "titleZh": value.get("titleZh", value.get("titleEn", "")),
                }
                for lp_code, value in sorted(lps.items())
            ],
            "exhibits": [
                {
                    "code": ex_code,
                    "titleEn": value.get("titleEn", value.get("titleZh", "")),
                    "titleZh": value.get("titleZh", value.get("titleEn", "")),
                }
                for ex_code, value in sorted(
                    exhibits.items(), key=lambda kv: [int(x) for x in kv[0].split(".")]
                )
            ],
        }
        if not lesson["learningPoints"]:
            raise SystemExit(f"no learning points found in {docx}")
        lessons.append(lesson)

    data = {
        "courseKey": "modeling-life",
        "categoryPath": ["Science"],
        "titleEn": "Modeling life",
        "titleZh": "建模生命",
        "shortDescriptionEn": (
            "See how mathematics models life, from population growth to neural "
            "activity and disease, using Euler's method."
        ),
        "shortDescriptionZh": (
            "了解数学如何为生命建模：从种群增长到神经活动与疾病，使用欧拉方法。"
        ),
        "overviewEn": (
            "Centred on dynamical systems and feedback, this course shows how "
            "differential equations underpin homeostasis, population dynamics, "
            "neural activity and disease."
        ),
        "overviewZh": (
            "本课程以动力系统与反馈为核心，说明微分方程如何支撑稳态、种群动态、"
            "神经活动与疾病建模。"
        ),
        "whatYouLearnEn": (
            "Model biological systems mathematically; simulate nonlinear dynamics "
            "with Euler's method; understand positive and negative feedback."
        ),
        "whatYouLearnZh": (
            "用数学为生物系统建模；用欧拉方法模拟非线性动力学；理解正反馈与负反馈。"
        ),
        "providesEn": (
            "Video and text dual-mode learning; reference exhibits; AI learning "
            "assistant; bilingual Chinese/English."
        ),
        "providesZh": ("视频与文本双模式学习；参考展品；AI 学习助手；中英双语。"),
        "learningLanguages": ["en-GB", "zh-CN"],
        "studyMode": "both",
        "lessons": lessons,
    }
    write_json(DATA_DIR / "course_content.json", data)
    counts = ", ".join(
        f"{lesson['code']}: {len(lesson['learningPoints'])} LPs, "
        f"{len(lesson['exhibits'])} exhibits"
        for lesson in lessons
    )
    print(f"course_content.json written ({counts})")


if __name__ == "__main__":
    main()
