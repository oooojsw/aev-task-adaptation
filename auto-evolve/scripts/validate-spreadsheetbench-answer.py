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
        if not os.path.exists(args.candidate):
            result = {
                "passed": False,
                "blocking": True,
                "summary": "Candidate file not found.",
                "details": [f"missing candidate: {args.candidate}"],
            }
            print(json.dumps(result, ensure_ascii=False))
            return 0
        expected = read_expected(args.answer, args.sheet, args.cell_range)
        got = read_candidate(args.candidate)
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
