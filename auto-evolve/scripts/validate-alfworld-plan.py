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
        return os.path.dirname(value)
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
        payload = load_payload(args.input_json)
        candidate_path = resolve_path(args.candidate, payload, prefer_payload_output=True)
        answer_path = resolve_path(args.answer, payload)
        if not os.path.exists(candidate_path):
            print(
                json.dumps(
                    {
                        "passed": False,
                        "blocking": True,
                        "summary": "Candidate plan file not found.",
                        "details": [f"missing candidate: {candidate_path}"],
                    },
                    ensure_ascii=False,
                )
            )
            return 0
        expected = read_expected(answer_path)
        got = read_candidate(candidate_path)
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
