#!/usr/bin/env python3
"""Download the exact OfficeQA parsed JSON files required by a direct-chat audit.

This intentionally avoids a full Hugging Face snapshot download. The OfficeQA
dataset is gated, so direct HTTP requests must include the locally saved HF
token.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import time
from pathlib import Path

import requests


def get_hf_token() -> str:
    try:
        from huggingface_hub import get_token

        token = get_token()
        if token:
            return token
    except Exception:
        pass

    for key in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        value = os.environ.get(key)
        if value:
            return value
    raise SystemExit("No Hugging Face token found. Run `hf auth login` first.")


def missing_names_from_audit(bundle_path: Path) -> list[str]:
    names: set[str] = set()
    with bundle_path.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            if not line.strip():
                continue
            item = json.loads(line)
            audit = item.get("materialAudit") or {}
            for source in audit.get("omittedSources") or []:
                match = re.search(r"treasury_bulletin_(\d{4})_(\d{2})\.pdf", source, re.I)
                if match:
                    names.add(f"treasury_bulletin_{match.group(1)}_{match.group(2)}.json")
    return sorted(names)


def required_names_from_split(split_path: Path, source_csv_path: Path) -> list[str]:
    split_payload = json.loads(split_path.read_text(encoding="utf-8-sig"))
    if not isinstance(split_payload, list):
        raise SystemExit(f"Expected a JSON array in split file: {split_path}")
    selected = {str(item).strip() for item in split_payload if str(item).strip()}
    names: set[str] = set()
    found: set[str] = set()
    with source_csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            uid = str(row.get("uid") or row.get("id") or "").strip()
            if uid not in selected:
                continue
            found.add(uid)
            source_files = str(row.get("source_files") or "")
            for match in re.finditer(r"treasury_bulletin_(\d{4})_(\d{2})\.(?:txt|pdf|json)", source_files, re.I):
                names.add(f"treasury_bulletin_{match.group(1)}_{match.group(2)}.json")
    missing_rows = sorted(selected - found)
    if missing_rows:
        raise SystemExit(f"Split UIDs missing from source CSV: {', '.join(missing_rows)}")
    return sorted(names)


def main() -> int:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--audit-bundle", help="direct-chat-dataset.bundle.jsonl from prepare-only audit")
    source.add_argument("--split", help="OfficeQA UID split JSON; requires --source-csv")
    parser.add_argument("--source-csv", help="OfficeQA source CSV used with --split")
    parser.add_argument(
        "--out-dir",
        default=r"C:\Users\ZhuanZ\Desktop\experiment\datasets\OfficeQA_corpus",
        help="OfficeQA corpus root containing treasury_bulletins_parsed/jsons",
    )
    parser.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or "")
    parser.add_argument("--max-retries", type=int, default=4)
    parser.add_argument("--sleep-seconds", type=float, default=1.0)
    args = parser.parse_args()

    target_dir = Path(args.out_dir) / "treasury_bulletins_parsed" / "jsons"
    target_dir.mkdir(parents=True, exist_ok=True)
    if args.split:
        if not args.source_csv:
            parser.error("--split requires --source-csv")
        names = required_names_from_split(Path(args.split), Path(args.source_csv))
    else:
        names = missing_names_from_audit(Path(args.audit_bundle))

    token = get_hf_token()
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})
    if args.proxy:
        session.proxies.update({"http": args.proxy, "https": args.proxy})

    base = "https://huggingface.co/datasets/databricks/officeqa/resolve/main/treasury_bulletins_parsed/jsons"
    downloaded = 0
    skipped = 0
    failed: list[str] = []

    print(f"Need {len(names)} parsed JSON files")
    for index, name in enumerate(names, start=1):
        dest = target_dir / name
        if dest.exists() and dest.stat().st_size > 0:
            skipped += 1
            continue
        url = f"{base}/{name}"
        last_error = ""
        for attempt in range(1, args.max_retries + 1):
            try:
                response = session.get(url, timeout=90)
                if response.status_code == 200 and response.content:
                    tmp = dest.with_suffix(dest.suffix + ".tmp")
                    tmp.write_bytes(response.content)
                    tmp.replace(dest)
                    downloaded += 1
                    print(f"[{index}/{len(names)}] downloaded {name} ({len(response.content)} bytes)", flush=True)
                    break
                last_error = f"HTTP {response.status_code}: {response.text[:200]}"
            except Exception as exc:
                last_error = repr(exc)
            if attempt < args.max_retries:
                time.sleep(args.sleep_seconds * attempt)
        else:
            failed.append(f"{name}: {last_error}")

    print(json.dumps({"downloaded": downloaded, "skipped": skipped, "failed": failed}, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
