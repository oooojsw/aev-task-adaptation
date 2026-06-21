"""Download the official OfficeQA parsed corpus used by SkillOpt-style evaluation.

This script intentionally downloads official parsed JSON/text from
databricks/officeqa. It does not OCR local PDFs.
"""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir",
        default=r"C:\Users\ZhuanZ\Desktop\experiment\datasets\OfficeQA_corpus",
        help="Directory that will contain treasury_bulletins_parsed/.",
    )
    parser.add_argument(
        "--kind",
        choices=("jsons", "transformed", "both"),
        default="jsons",
        help="Which official parsed representation to download.",
    )
    args = parser.parse_args()

    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:  # pragma: no cover - environment guard
        raise SystemExit("Install huggingface_hub first: pip install huggingface_hub") from exc

    patterns: list[str] = []
    if args.kind in ("jsons", "both"):
        patterns.append("treasury_bulletins_parsed/jsons/*.json")
    if args.kind in ("transformed", "both"):
        patterns.append("treasury_bulletins_parsed/transformed/*.txt")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {patterns} to {out_dir}")
    result = snapshot_download(
        repo_id="databricks/officeqa",
        repo_type="dataset",
        local_dir=str(out_dir),
        allow_patterns=patterns,
        resume_download=True,
    )
    print(result)


if __name__ == "__main__":
    main()
