#!/usr/bin/env python3
"""Regenerate every long-range fixture from the real source zip, then verify.

Run: python3 -I scripts/build_all.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
STEPS = [
    "build_f1_real_package.py",
    "build_course_data.py",
    "build_packages.py",
    "build_f4_bad_packages.py",
    "verify_fixtures.py",
]


def main() -> None:
    for step in STEPS:
        print(f"\n=== {step} ===", flush=True)
        subprocess.run(
            [sys.executable, "-I", str(SCRIPTS / step)],
            check=True,
        )
    print("\nall fixtures rebuilt and verified")


if __name__ == "__main__":
    main()
