#!/usr/bin/env python
import argparse
import json
import os
import re
import sys
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_json", nargs="?", default=None)
    parser.add_argument("--answer", required=True)
    parser.add_argument("--candidate", required=True)
    return parser.parse_args()


def normalize_action(value: Any) -> str:
    text = str(value).strip().lower()
    text = re.sub(r"^\s*\d+[\).\:-]\s*", "", text)
    text = re.sub(r"\s+", " ", text)
    return text


def read_expected(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8-sig") as f:
        raw = json.load(f)
    actions = raw.get("walkthrough") if isinstance(raw, dict) else raw
    if not isinstance(actions, list) or not actions:
        raise RuntimeError("expected answer must contain a non-empty walkthrough list")
    return [normalize_action(item) for item in actions]


def read_candidate(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8-sig") as f:
        raw = json.load(f)
    if isinstance(raw, list):
        actions = raw
    elif isinstance(raw, dict):
        actions = raw.get("actions") or raw.get("plan") or raw.get("walkthrough")
    else:
        actions = None
    if not isinstance(actions, list) or not actions:
        raise RuntimeError("candidate must be JSON list or object with actions/plan list")
    return [normalize_action(item) for item in actions]


def main() -> int:
    try:
        args = parse_args()
        if not os.path.exists(args.candidate):
            print(
                json.dumps(
                    {
                        "passed": False,
                        "blocking": True,
                        "summary": "Candidate plan file not found.",
                        "details": [f"missing candidate: {args.candidate}"],
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        expected = read_expected(args.answer)
        got = read_candidate(args.candidate)
        passed = expected == got
        details = []
        if not passed:
            details.append(f"expected_length={len(expected)} got_length={len(got)}")
            for index, (left, right) in enumerate(zip(expected, got), start=1):
                if left != right:
                    details.append(f"step {index}: expected={left!r} got={right!r}")
                    break
            if len(expected) != len(got):
                details.append(f"expected={expected}")
                details.append(f"got={got}")
        else:
            details.append(f"matched {len(expected)} actions")
        print(
            json.dumps(
                {
                    "passed": passed,
                    "blocking": True,
                    "summary": "ALFWorld walkthrough matched." if passed else "ALFWorld walkthrough mismatch.",
                    "details": details,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "passed": False,
                    "blocking": True,
                    "summary": "Validator crashed.",
                    "details": [str(exc)],
                },
                ensure_ascii=False,
            )
        )
        return 0


if __name__ == "__main__":
    sys.exit(main())
