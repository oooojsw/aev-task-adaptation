from __future__ import annotations

import argparse
from pathlib import Path

from pypdf import PdfReader


KEYWORDS = (
    "abstract",
    "retriev",
    "validat",
    "verif",
    "top-k",
    "top k",
    "budget",
    "library",
    "compose",
    "composition",
    "local skill",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--pages", type=int, default=14)
    args = parser.parse_args()

    for path in args.paths:
        reader = PdfReader(path)
        print(f"\n===== {path.name} ({len(reader.pages)} pages) =====")
        for page_number, page in enumerate(reader.pages[: args.pages], start=1):
            text = " ".join((page.extract_text() or "").split())
            lowered = text.lower()
            if page_number <= 2 or any(keyword in lowered for keyword in KEYWORDS):
                print(f"\n--- page {page_number} ---\n{text[:5000]}")


if __name__ == "__main__":
    main()
