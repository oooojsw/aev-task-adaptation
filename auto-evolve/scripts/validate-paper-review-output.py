#!/usr/bin/env python3
"""Hard validator for paper-review long-task outputs.

The task spec exposes only the paper PDF.  This validator derives the private
gold review from the task id and compares the candidate review's final rating
against the gold Word review while also enforcing a minimal review structure.
"""

from __future__ import annotations

import html
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any


ALLOWED_RATINGS = [
    "strong accept",
    "accept",
    "weak accept",
    "borderline",
    "weak reject",
    "reject",
]

REQUIRED_SECTIONS = [
    "summary",
    "strengths",
    "weaknesses",
    "justification of rating",
    "paper rating",
]


def emit(passed: bool, summary: str, details: list[str], *, blocking: bool = True) -> None:
    print(
        json.dumps(
            {
                "passed": passed,
                "blocking": blocking,
                "summary": summary,
                "details": details,
                "failureKind": "product_failure" if not passed else None,
            },
            ensure_ascii=False,
        )
    )


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def strip_docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as zf:
        xml = zf.read("word/document.xml").decode("utf-8", errors="ignore")
    text = re.sub(r"<[^>]+>", " ", xml)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def read_text_any(path: Path) -> str:
    if path.suffix.lower() == ".docx":
        return strip_docx_text(path)
    return path.read_text(encoding="utf-8", errors="ignore")


def normalize_rating(value: str) -> str | None:
    text = re.sub(r"\s+", " ", value.lower()).strip()
    text = text.replace("：", ":")
    text = re.sub(
        r"\bmarginally\s+accept(?:\s*\(\s*borderline\s*\))?\b",
        "borderline",
        text,
        flags=re.I,
    )
    section_match = re.search(r"paper\s*rating\b(.{0,240})", text, flags=re.I)
    section_text = section_match.group(1) if section_match else ""
    if section_text:
        section_score = re.search(r"\b([1-7])\b", section_text)
        if section_score:
            score = int(section_score.group(1))
            if score >= 7:
                return "strong accept"
            if score == 6:
                return "weak accept"
            if score == 5:
                return "borderline"
            if score == 4:
                return "weak reject"
            return "reject"
        section_label = re.search(
            r"\b(strong accept|weak accept|borderline|weak reject|reject|accept)\b",
            section_text,
            flags=re.I,
        )
        if section_label:
            return section_label.group(1).lower()
    # Prefer explicit Paper Rating lines over incidental words elsewhere.
    patterns = [
        r"paper\s*rating\s*[:：]?\s*(strong accept|weak accept|borderline|weak reject|reject|accept)",
        r"\brating\s*[:：]?\s*(strong accept|weak accept|borderline|weak reject|reject|accept)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.I)
        if match:
            return match.group(1).lower()
    numeric_patterns = [
        r"paper\s*rating\s*[:：]?\s*\**\s*([1-7])\b",
        r"\brating\s*[:：]\s*\**\s*([1-7])\b",
    ]
    for pattern in numeric_patterns:
        match = re.search(pattern, text, flags=re.I)
        if match:
            score = int(match.group(1))
            if score >= 7:
                return "strong accept"
            if score == 6:
                return "weak accept"
            if score == 5:
                return "borderline"
            if score == 4:
                return "weak reject"
            return "reject"
    # Fallback: last rating-like label in the document.
    matches = re.findall(r"\b(strong accept|weak accept|borderline|weak reject|reject|accept)\b", text, flags=re.I)
    if matches:
        return matches[-1].lower()
    return None


def candidate_paths(payload: dict[str, Any], payload_path: Path) -> list[Path]:
    paths: list[Path] = []
    for key in ("expectedArtifacts", "targetPaths", "editablePaths"):
        raw = payload.get(key)
        if not isinstance(raw, list):
            continue
        for item in raw:
            if isinstance(item, str):
                paths.append(Path(item))
            elif isinstance(item, dict) and isinstance(item.get("path"), str):
                paths.append(Path(item["path"]))
    bundle_path = payload.get("bundlePath")
    if isinstance(bundle_path, str):
        try:
            bundle = read_json(Path(bundle_path))
            for key in ("expectedArtifacts", "targetPaths"):
                raw = bundle.get(key)
                if isinstance(raw, list):
                    for item in raw:
                        if isinstance(item, str):
                            paths.append(Path(item))
                        elif isinstance(item, dict) and isinstance(item.get("path"), str):
                            paths.append(Path(item["path"]))
        except Exception:
            pass
    # Common fallbacks near validator_input.json in runtime sandboxes.
    root = payload_path.parent
    for parent in [root, *root.parents[:6]]:
        paths.extend([parent / "workspace" / "review.md", parent / "workspace" / "review.docx"])
    preferred = []
    for p in paths:
        if p.name.lower() in {"review.md", "review.docx", "review.txt"}:
            preferred.append(p)
    seen: set[str] = set()
    out: list[Path] = []
    for p in preferred + paths:
        key = str(p).lower()
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out


def find_candidate(payload: dict[str, Any], payload_path: Path) -> Path | None:
    for p in candidate_paths(payload, payload_path):
        if p.exists() and p.is_file():
            return p
    return None


def find_gold_review(payload: dict[str, Any], cwd: Path) -> Path | None:
    task_id = str(payload.get("runID") or "")
    task = payload.get("task")
    if isinstance(task, dict) and isinstance(task.get("id"), str):
        task_id = task["id"]
    # Long-task script payload uses unitID/runID, not task.id.  Infer the paper id
    # from any material path if needed.
    materials = payload.get("materials")
    material_text = json.dumps(materials, ensure_ascii=False) if materials is not None else ""
    match = re.search(r"paper-review-(\d{4})", task_id + " " + material_text, flags=re.I)
    if not match:
        match = re.search(r"tasks[\\/](paper-review-\d{4})", material_text, flags=re.I)
    if match:
        case_id = match.group(0) if match.group(0).startswith("paper-review-") else f"paper-review-{match.group(1)}"
    else:
        # Spec id is usually present in the payload goal/check bundle.
        blob = json.dumps(payload, ensure_ascii=False)
        match = re.search(r"paper-review-(\d{4})", blob, flags=re.I)
        case_id = f"paper-review-{match.group(1)}" if match else ""
    if not case_id:
        return None

    search_roots: list[Path] = [cwd]
    # Validator execution cwd can be a deep blank-eval sandbox.  Walk from any
    # payload/material path upward until we find the auto-evolve task-pack root.
    path_blob = json.dumps(
        {
            "payloadPath": str(payload.get("payloadPath") or ""),
            "bundlePath": str(payload.get("bundlePath") or ""),
            "materials": materials,
            "targetPaths": payload.get("targetPaths"),
            "expectedArtifacts": payload.get("expectedArtifacts"),
        },
        ensure_ascii=False,
    )
    for raw_path in re.findall(r"[A-Za-z]:[\\/][^\"<>|]+", path_blob):
        try:
            p = Path(raw_path)
            search_roots.extend([p, *p.parents])
        except Exception:
            continue
    search_roots.extend([cwd, *cwd.parents])

    task_pack_suffix = Path("task-packs") / "real-long-tasks" / "paper-review-learnbench"
    candidates: list[Path] = []
    seen_roots: set[str] = set()
    for root in search_roots:
        root_key = str(root.resolve()) if root.exists() else str(root)
        if root_key in seen_roots:
            continue
        seen_roots.add(root_key)
        for base in [root, root / "auto-evolve"]:
            task_pack = base / task_pack_suffix
            answer_root = task_pack / "private-answers" / case_id
            candidates.extend(
                [
                    answer_root / "gold-review.docx",
                    answer_root / "gold-review.txt",
                    answer_root / "rating.txt",
                ]
            )
    for path in candidates:
        if path.exists():
            return path
    return None


def main() -> int:
    if len(sys.argv) != 2:
        emit(False, "Usage: validate-paper-review-output.py <validator_input.json>", ["missing input path"])
        return 2
    payload_path = Path(sys.argv[1])
    payload = read_json(payload_path)
    cwd = Path.cwd()
    candidate = find_candidate(payload, payload_path)
    if candidate is None:
        emit(False, "Candidate review file not found.", ["Expected workspace/review.md or workspace/review.docx."])
        return 1
    gold = find_gold_review(payload, cwd)
    if gold is None:
        emit(False, "Private gold review not found.", ["Could not infer private-answers/<paper-review-id>/gold-review.docx."])
        return 1

    candidate_text = read_text_any(candidate)
    gold_text = read_text_any(gold)
    candidate_rating = normalize_rating(candidate_text)
    gold_rating = normalize_rating(gold_text)
    missing_sections = [section for section in REQUIRED_SECTIONS if section not in candidate_text.lower()]
    details = [
        f"candidate={candidate}",
        f"gold={gold}",
        f"candidate_rating={candidate_rating}",
        f"gold_rating={gold_rating}",
    ]
    if len(candidate_text.strip()) < 1200:
        details.append("candidate review is too short (<1200 chars)")
    if missing_sections:
        details.append("missing_sections=" + ", ".join(missing_sections))
    if candidate_rating not in ALLOWED_RATINGS:
        details.append("candidate rating is missing or invalid")
    if gold_rating not in ALLOWED_RATINGS:
        details.append("gold rating is missing or invalid")

    passed = (
        len(candidate_text.strip()) >= 1200
        and not missing_sections
        and candidate_rating in ALLOWED_RATINGS
        and gold_rating in ALLOWED_RATINGS
        and candidate_rating == gold_rating
    )
    summary = (
        f"Paper-review hard check passed with rating {candidate_rating}."
        if passed
        else "Paper-review hard check failed."
    )
    emit(passed, summary, details)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
