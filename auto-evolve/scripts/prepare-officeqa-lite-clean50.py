"""Materialize the frozen OfficeQA clean50 split for read-only Lite adapters."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
from pathlib import Path

from pypdf import PdfReader


def read_rows(path: Path) -> list[dict]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise RuntimeError(f"Expected a JSON row array: {path}")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalized(value: object) -> str:
    return " ".join(str(value or "").split())


def sources(row: dict) -> list[str]:
    raw = row.get("source_files")
    return [str(item).strip() for item in (raw if isinstance(raw, list) else str(raw or "").splitlines()) if str(item).strip()]


def csv_record(uid: str, metadata: dict, original: dict) -> dict:
    question = str(original.get("question") or "").strip()
    answer = str(original.get("answer") or "").strip()
    if not question or not answer or sources(original) != sources(metadata):
        raise RuntimeError(f"Full OfficeQA CSV does not match split metadata for {uid}")
    return {
        **metadata,
        "question": question,
        "answer": answer,
        "ground_truth": answer,
        "difficulty": metadata.get("category", ""),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-split", type=Path, required=True)
    parser.add_argument("--materialized-48", type=Path, required=True)
    parser.add_argument("--old-docs", type=Path, required=True)
    parser.add_argument("--full-csv", type=Path, required=True)
    parser.add_argument("--task-pack", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if out.exists():
        raise RuntimeError(f"Refusing to overwrite an existing materialization: {out}")

    tasks = args.task_pack / "tasks"
    with args.full_csv.open(encoding="utf-8-sig", newline="") as handle:
        full_rows = list(csv.DictReader(handle))
    full_by_uid = {str(row["uid"]): row for row in full_rows}
    if len(full_by_uid) != len(full_rows):
        raise RuntimeError("Full OfficeQA CSV contains duplicate UIDs")
    official: dict[str, list[dict]] = {}
    existing: dict[str, dict[str, dict]] = {}
    ids: dict[str, set[str]] = {}
    for split, count in (("train", 50), ("val", 24), ("test", 172)):
        official[split] = read_rows(args.official_split / split / "items.json")
        old_rows = read_rows(args.materialized_48 / split / "items.json")
        existing[split] = {str(row["id"]): row for row in old_rows}
        ids[split] = {str(row["id"]) for row in official[split]}
        if len(official[split]) != count or len(ids[split]) != count:
            raise RuntimeError(f"Official {split} split is not {count} unique UIDs")
        if set(existing[split]) - ids[split]:
            raise RuntimeError(f"Old {split} data contains IDs outside the official split")
        if split != "train" and set(existing[split]) != ids[split]:
            raise RuntimeError(f"Old {split} data does not cover the official split")
    if ids["train"] & ids["val"] or ids["train"] & ids["test"] or ids["val"] & ids["test"]:
        raise RuntimeError("Official split UID overlap")

    new_rows: dict[str, list[dict]] = {}
    missing_rows: list[str] = []
    for split, metadata_rows in official.items():
        selected: list[dict] = []
        for metadata in metadata_rows:
            uid = str(metadata["id"])
            if uid not in full_by_uid:
                raise RuntimeError(f"Full OfficeQA CSV is missing {uid}")
            canonical = csv_record(uid, metadata, full_by_uid[uid])
            old = existing[split].get(uid)
            if old:
                for field in ("question", "ground_truth"):
                    if normalized(old.get(field)) != normalized(canonical[field]):
                        raise RuntimeError(f"Old {split} {uid} differs from task source in {field}")
                if sources(old) != sources(metadata):
                    raise RuntimeError(f"Old {split} {uid} has different source document names")
                selected.append(old)
            else:
                if split != "train":
                    raise RuntimeError(f"Missing {split} row {uid}")
                missing_rows.append(uid)
                selected.append(canonical)
        new_rows[split] = selected

    needed = {name for rows in official.values() for row in rows for name in sources(row)}
    if not needed or any(Path(name).name != name for name in needed):
        raise RuntimeError("Invalid OfficeQA source document names")
    missing_docs = sorted(name for name in needed if not (args.old_docs / name).is_file())
    pdf_sources: dict[str, Path] = {}
    extracted: dict[str, str] = {}
    for name in missing_docs:
        candidates = sorted(tasks.glob(f"*/materials/{Path(name).stem}.pdf"))
        if not candidates:
            raise RuntimeError(f"Missing source PDF for {name}")
        hashes = {sha256(candidate) for candidate in candidates}
        if len(hashes) != 1:
            raise RuntimeError(f"Conflicting copies of source PDF for {name}")
        pdf_sources[name] = candidates[0]
        reader = PdfReader(str(candidates[0]))
        text = "\n\f\n".join(page.extract_text() or "" for page in reader.pages)
        if len(text.strip()) < 1000:
            raise RuntimeError(f"PDF text extraction insufficient for {name}; OCR review required")
        extracted[name] = text

    # Only create the output after every source row and PDF passed preflight.
    split_root = out / "split"
    docs_root = out / "docs"
    for split, rows in new_rows.items():
        target = split_root / split / "items.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    docs_root.mkdir(parents=True)
    for name in sorted(needed):
        target = docs_root / name
        if name in extracted:
            target.write_text(extracted[name], encoding="utf-8")
        else:
            shutil.copy2(args.old_docs / name, target)

    manifest = {
        "schema": "auto-evolve/officeqa-lite-clean50-materialization/v1",
        "splitCounts": {split: len(rows) for split, rows in new_rows.items()},
        "addedTrainUIDs": missing_rows,
        "extractedPDFs": {name: {"source": str(pdf_sources[name]), "sha256": sha256(pdf_sources[name])} for name in missing_docs},
        "splitHashes": {split: sha256(split_root / split / "items.json") for split in new_rows},
        "docsCount": len(needed),
        "outputRoot": str(out),
    }
    (out / "materialization-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
