import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> None:
    ledger = Path(sys.argv[1])
    archive_dir = ledger.parent / "infra-bug-archive"
    archive_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    raw_copy = archive_dir / f"results-before-dedup-{stamp}.jsonl"
    shutil.copy2(ledger, raw_copy)

    seen: set[str] = set()
    kept: list[str] = []
    duplicate_ids: list[str] = []
    for line in ledger.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        item_id = str(record["id"])
        if item_id in seen:
            duplicate_ids.append(item_id)
            continue
        seen.add(item_id)
        kept.append(line)

    temp = ledger.with_suffix(".jsonl.tmp")
    temp.write_text("\n".join(kept) + "\n", encoding="utf-8")
    temp.replace(ledger)
    audit = {
        "action": "deduplicate_resume_ledger",
        "selection_policy": "keep first chronological record per task id; do not select by score",
        "raw_archive": str(raw_copy),
        "raw_records": len(kept) + len(duplicate_ids),
        "kept_unique_records": len(kept),
        "removed_duplicate_records": len(duplicate_ids),
        "duplicate_ids": duplicate_ids,
        "missing_from_official_280": 280 - len(kept),
    }
    (archive_dir / f"dedup-audit-{stamp}.json").write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(audit, ensure_ascii=False))


if __name__ == "__main__":
    main()
