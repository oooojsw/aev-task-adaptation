#!/usr/bin/env python
import argparse
import json
import math
import os
import sys
from typing import Any

from openpyxl import load_workbook


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_json", nargs="?", default=None)
    parser.add_argument("--answer", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--sheet", required=True)
    parser.add_argument("--range", dest="cell_range", required=True)
    return parser.parse_args()


def load_payload(path_text: str | None) -> dict:
    if not path_text:
        return {}
    path = os.path.abspath(path_text)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def infer_task_dir(payload: dict) -> str | None:
    for item in payload.get("materials", []):
        if not isinstance(item, dict):
            continue
        value = item.get("path")
        role = item.get("role")
        if isinstance(value, str) and role == "human-guidance" and os.path.exists(value):
            return os.path.dirname(value)
    for item in payload.get("materials", []):
        if not isinstance(item, dict):
            continue
        value = item.get("path")
        if not isinstance(value, str) or not os.path.exists(value):
            continue
        parent = os.path.dirname(value)
        return os.path.dirname(parent) if os.path.basename(parent).lower() == "materials" else parent
    return None


def payload_output_candidates(payload: dict) -> list[str]:
    out: list[str] = []
    for item in payload.get("targetPaths", []):
        if isinstance(item, dict) and isinstance(item.get("path"), str):
            out.append(item["path"])
    for item in payload.get("expectedArtifacts", []):
        if isinstance(item, str):
            out.append(item)
    return out


def resolve_path(value: str, payload: dict, *, prefer_payload_output: bool = False) -> str:
    if os.path.isabs(value):
        return value
    if prefer_payload_output:
        wanted = os.path.basename(value).lower()
        for item in payload_output_candidates(payload):
            if os.path.basename(item).lower() == wanted and os.path.exists(item):
                return item
        for item in payload_output_candidates(payload):
            if os.path.basename(item).lower() == wanted:
                return item
    task_dir = infer_task_dir(payload)
    if task_dir:
        candidate = os.path.abspath(os.path.join(task_dir, value))
        if os.path.exists(candidate):
            return candidate
    return os.path.abspath(value)


def norm(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if math.isfinite(v):
            return round(v, 8)
        return str(v)
    s = str(v).strip()
    if "T" in s and len(s) >= 19 and s[4] == "-" and s[7] == "-":
      s = s.replace("T", " ")
    # normalize numeric-looking strings
    try:
        fv = float(s)
        if math.isfinite(fv):
            return round(fv, 8)
    except Exception:
        pass
    return s


def split_sheet_range(sheet_name: str, cell_range: str) -> tuple[str, str]:
    rng = cell_range.strip()
    if "!" in rng:
        left, right = rng.split("!", 1)
        left = left.strip().strip("'").strip('"')
        return left or sheet_name, right.strip()
    return sheet_name, rng


def read_expected(answer_path: str, sheet_name: str, cell_range: str) -> list[list[Any]]:
    sheet_name, cell_range = split_sheet_range(sheet_name, cell_range)
    wb = load_workbook(answer_path, data_only=True, read_only=True)
    if sheet_name not in wb.sheetnames:
        raise RuntimeError(f"answer sheet not found: {sheet_name}")
    ws = wb[sheet_name]
    rows = []
    for row in ws[cell_range]:
        rows.append([norm(cell.value) for cell in row])
    return rows


def read_candidate(candidate_path: str) -> list[list[Any]]:
    with open(candidate_path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise RuntimeError("candidate json must be an object")
    values = raw.get("values")
    if not isinstance(values, list):
        raise RuntimeError("candidate json must contain values: list[list]")
    out: list[list[Any]] = []
    for row in values:
        if not isinstance(row, list):
            raise RuntimeError("candidate values must be list[list]")
        out.append([norm(v) for v in row])
    return out


def compare_rows(expected: list[list[Any]], got: list[list[Any]]) -> tuple[bool, list[str]]:
    details: list[str] = []
    if len(expected) != len(got):
        details.append(f"row count mismatch: expected={len(expected)} got={len(got)}")
        return False, details
    for r, (erow, grow) in enumerate(zip(expected, got), start=1):
        if len(erow) != len(grow):
            details.append(f"col count mismatch at row {r}: expected={len(erow)} got={len(grow)}")
            return False, details
        for c, (ev, gv) in enumerate(zip(erow, grow), start=1):
            if ev != gv:
                details.append(f"mismatch at r{r}c{c}: expected={ev!r} got={gv!r}")
                if len(details) >= 20:
                    return False, details
    return len(details) == 0, details


def main() -> int:
    args = parse_args()
    try:
        payload = load_payload(args.input_json)
        candidate_path = resolve_path(args.candidate, payload, prefer_payload_output=True)
        answer_path = resolve_path(args.answer, payload)
        if not os.path.exists(candidate_path):
            result = {
                "passed": False,
                "blocking": True,
                "summary": "Candidate file not found.",
                "details": [f"missing candidate: {candidate_path}"],
            }
            print(json.dumps(result, ensure_ascii=False))
            return 0
        expected = read_expected(answer_path, args.sheet, args.cell_range)
        got = read_candidate(candidate_path)
        passed, diffs = compare_rows(expected, got)
        result = {
            "passed": passed,
            "blocking": True,
            "summary": "Spreadsheet answer matched." if passed else "Spreadsheet answer mismatch.",
            "details": diffs if diffs else [f"matched sheet={args.sheet} range={args.cell_range}"],
        }
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as e:
        result = {
            "passed": False,
            "blocking": True,
            "summary": "Validator crashed.",
            "details": [str(e)],
        }
        print(json.dumps(result, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    sys.exit(main())
