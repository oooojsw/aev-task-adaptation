from __future__ import annotations

import argparse
import datetime
import hashlib
import json
from pathlib import Path


INFRA_MARKERS = (
    "http 401", "http 402", "http 403", "http 408", "http 429",
    "http 500", "http 502", "http 503", "http 504", "timed out",
    "timeout", "connection error", "authentication", "unauthorized",
    "rate limit", "provider", "empty response", "api error",
    "unicodeencodeerror", "judge crashed", "judge_crash",
)


def read_rows(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    rows = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSONL at {path}:{line_no}: {exc}") from exc
    return rows


def write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    temp.replace(path)


def is_infra(row: dict) -> bool:
    phase = str(row.get("phase") or "").lower()
    text = " ".join(str(row.get(key) or "") for key in (
        "phase", "fail_reason", "error", "response",
    )).lower()
    if phase == "timeout":
        return True
    if "_auto_verify_output" in text or "spreadsheetbench\\evaluator.py" in text:
        return True
    if "agent_ok" in row and row.get("agent_ok") is False and not str(row.get("response") or "").strip():
        return True
    return any(marker in text for marker in INFRA_MARKERS)


def uid(row: dict) -> str:
    return str(row.get("id") or "").strip()


def audit(path: Path, expected: int) -> dict:
    rows = read_rows(path)
    ids = [uid(row) for row in rows]
    infra_ids = sorted({uid(row) for row in rows if is_infra(row) and uid(row)})
    duplicate_ids = sorted({item for item in ids if item and ids.count(item) > 1})
    return {
        "rows": len(rows),
        "uniqueIds": len(set(ids)),
        "expected": expected,
        "complete": len(rows) == expected and len(set(ids)) == expected,
        "infraIds": infra_ids,
        "duplicateIds": duplicate_ids,
        "hardPasses": sum(1 for row in rows if float(row.get("hard") or 0) >= 1),
        "softSum": sum(float(row.get("soft") or 0) for row in rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    seed = sub.add_parser("seed")
    seed.add_argument("--source", required=True)
    seed.add_argument("--target", required=True)
    seed.add_argument("--drop", default="")
    check = sub.add_parser("audit")
    check.add_argument("--path", required=True)
    check.add_argument("--expected", required=True, type=int)
    clean = sub.add_parser("drop-infra")
    clean.add_argument("--path", required=True)
    fingerprint = sub.add_parser("fingerprint")
    fingerprint.add_argument("--path", required=True)
    restore = sub.add_parser("restore-uid")
    restore.add_argument("--source", required=True)
    restore.add_argument("--target", required=True)
    restore.add_argument("--uid", required=True)
    restore.add_argument("--reason", required=True)
    args = parser.parse_args()

    if args.action == "seed":
        source = Path(args.source)
        target = Path(args.target)
        drops = {item.strip() for item in args.drop.split(",") if item.strip()}
        rows = [row for row in read_rows(source) if uid(row) not in drops]
        write_rows(target, rows)
        print(json.dumps({"seeded": len(rows), "dropped": sorted(drops)}, ensure_ascii=False))
    elif args.action == "audit":
        print(json.dumps(audit(Path(args.path), args.expected), ensure_ascii=False))
    elif args.action == "drop-infra":
        path = Path(args.path)
        rows = read_rows(path)
        infra_rows = [row for row in rows if is_infra(row)]
        removed = sorted({uid(row) for row in infra_rows if uid(row)})
        archive_path = None
        if infra_rows:
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            archive_path = path.parent / "infrastructure-archive" / f"{stamp}.jsonl"
            write_rows(archive_path, infra_rows)
        kept = [row for row in rows if not is_infra(row)]
        write_rows(path, kept)
        print(json.dumps({
            "removed": removed,
            "remaining": len(kept),
            "archive": str(archive_path) if archive_path else "",
        }, ensure_ascii=False))
    elif args.action == "fingerprint":
        path = Path(args.path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest().upper()
        print(json.dumps({"path": str(path.resolve()), "bytes": path.stat().st_size, "sha256": digest}))
    else:
        source = Path(args.source)
        target = Path(args.target)
        matches = [row for row in read_rows(source) if uid(row) == args.uid]
        if len(matches) != 1:
            raise ValueError(f"expected one source row for {args.uid}, got {len(matches)}")
        row = matches[0]
        if is_infra(row):
            raise ValueError(f"refusing to restore infrastructure-failed source row {args.uid}")
        rows = [existing for existing in read_rows(target) if uid(existing) != args.uid]
        restored = dict(row)
        restored["reusedEvidence"] = {
            "source": str(source.resolve()),
            "reason": args.reason,
            "restoredAt": datetime.datetime.now().astimezone().isoformat(),
        }
        rows.append(restored)
        write_rows(target, rows)
        print(json.dumps({"restored": args.uid, "targetRows": len(rows)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
