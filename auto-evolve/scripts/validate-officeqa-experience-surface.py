#!/usr/bin/env python3
"""OfficeQA first-layer expert-surface generalization validator.

This validator intentionally does not need per-task gold answers. It blocks
high-confidence answer leakage surfaces, while allowing ordinary numeric
guidance such as page numbers, table numbers, years, and formatting examples.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


DEFAULT_ALLOWED_EXTENSIONS = [
    ".md",
    ".txt",
    ".json",
    ".jsonl",
    ".yaml",
    ".yml",
    ".py",
    ".ps1",
    ".sh",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
]
NUMBER_RE = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?%?")


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def normalize_path(value: str) -> str:
    return value.replace("\\", "/").lower()


def make_result(passed: bool, summary: str, failures: list[dict[str, Any]], warnings: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "passed": passed,
        "summary": summary,
        "details": {
            "failures": failures,
            "warnings": warnings,
            "failureCount": len(failures),
            "warningCount": len(warnings),
        },
    }


def emit(result: dict[str, Any]) -> int:
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result.get("passed") else 1


def resolve_roots(input_data: dict[str, Any], config: dict[str, Any]) -> list[Path]:
    roots: list[Path] = []
    root_roles = set(config.get("rootRoles") or ["experience-workspace"])
    for target in input_data.get("targetPaths") or []:
        role = target.get("role")
        path_value = target.get("path")
        if role in root_roles and path_value:
            roots.append(Path(path_value).resolve())
    for path_value in config.get("rootPaths") or []:
        roots.append(Path(path_value).resolve())
    return roots


def should_ignore(path: Path, config: dict[str, Any]) -> bool:
    normalized = normalize_path(str(path))
    return any(normalize_path(item) in normalized for item in config.get("ignorePathSubstrings") or [])


def iter_candidate_files(roots: list[Path], config: dict[str, Any]) -> list[Path]:
    allowed = set(config.get("allowedExtensions") or DEFAULT_ALLOWED_EXTENSIONS)
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        if root.is_file():
            if root.suffix.lower() in allowed and not should_ignore(root, config):
                files.append(root)
            continue
        for current_root, dir_names, file_names in os.walk(root):
            base = Path(current_root)
            dir_names[:] = [name for name in dir_names if not should_ignore(base / name, config)]
            for name in file_names:
                file_path = base / name
                if file_path.suffix.lower() in allowed and not should_ignore(file_path, config):
                    files.append(file_path)
    return files


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def scan_text_with_filename(path: Path) -> str:
    return f"FileNameContext: {path.name}\n{read_text(path)}"


def compile_flags(flag_names: list[str]) -> int:
    flags = 0
    for name in flag_names:
        flags |= getattr(re, name, 0)
    return flags


def location(file_path: Path, text: str, offset: int) -> dict[str, Any]:
    line = text.count("\n", 0, offset) + 1
    return {"file": str(file_path), "line": line}


def add_hit(
    hits: list[dict[str, Any]],
    file_path: Path,
    text: str,
    offset: int,
    kind: str,
    message: str,
    evidence: str,
    config: dict[str, Any],
) -> None:
    max_per_file = int(config.get("maxHitsPerFile") or 6)
    max_total = int(config.get("maxTotalHits") or 30)
    if len(hits) >= max_total:
        return
    if sum(1 for hit in hits if hit.get("file") == str(file_path)) >= max_per_file:
        return
    hit = location(file_path, text, offset)
    hit.update({"kind": kind, "message": message, "evidence": evidence.strip()[:240]})
    hits.append(hit)


def check_required_files(roots: list[Path], config: dict[str, Any]) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for required in config.get("requiredFiles") or []:
        found = False
        for root in roots:
            if (root / required).exists():
                found = True
                break
        if not found:
            failures.append(
                {
                    "kind": "required-file-missing",
                    "message": f"Required expert package file is missing: {required}",
                    "file": required,
                }
            )
    return failures


def check_forbidden_patterns(files: list[Path], config: dict[str, Any]) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    specs = config.get("forbiddenPatterns") or []
    compiled: list[tuple[str, re.Pattern[str]]] = []
    for spec in specs:
        pattern = spec.get("pattern")
        if not pattern:
            continue
        compiled.append((spec.get("label") or pattern, re.compile(pattern, compile_flags(spec.get("flags") or []))))

    for file_path in files:
        text = scan_text_with_filename(file_path)
        for label, pattern in compiled:
            for match in pattern.finditer(text):
                add_hit(
                    failures,
                    file_path,
                    text,
                    match.start(),
                    "forbidden-pattern",
                    f"Forbidden answer-leakage surface matched: {label}",
                    match.group(0),
                    config,
                )
    return failures


def looks_like_concrete_result(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, bool):
        return False
    text = str(value).strip()
    if not text:
        return False
    if len(text) <= 120 and NUMBER_RE.search(text):
        return True
    if len(text) <= 80 and re.search(r"\b(blocker|yes|no|true|false|n/a|none)\b", text, re.IGNORECASE):
        return True
    return False


def iter_scalars(value: Any) -> list[Any]:
    if isinstance(value, dict):
        scalars: list[Any] = []
        for item in value.values():
            scalars.extend(iter_scalars(item))
        return scalars
    if isinstance(value, list):
        scalars = []
        for item in value:
            scalars.extend(iter_scalars(item))
        return scalars
    return [value]


def scan_structured_value(
    value: Any,
    file_path: Path,
    key_path: list[str],
    config: dict[str, Any],
    failures: list[dict[str, Any]],
) -> None:
    strong_keys = {item.lower() for item in config.get("structuredDangerKeys") or []}
    conditional_keys = {item.lower() for item in config.get("structuredConditionalKeys") or []}
    if isinstance(value, dict):
        for key, item in value.items():
            lowered = str(key).lower()
            current_path = key_path + [str(key)]
            if lowered in strong_keys:
                if any(looks_like_concrete_result(scalar) for scalar in iter_scalars(item)):
                    failures.append(
                        {
                            "kind": "structured-answer-container",
                            "file": str(file_path),
                            "message": f"High-risk answer key contains a concrete value: {'.'.join(current_path)}",
                            "evidence": str(item)[:240],
                        }
                    )
            elif lowered in conditional_keys and looks_like_concrete_result(item):
                failures.append(
                    {
                        "kind": "structured-answer-container",
                        "file": str(file_path),
                        "message": f"Answer-like key contains a concrete value: {'.'.join(current_path)}",
                        "evidence": str(item)[:240],
                    }
                )
            scan_structured_value(item, file_path, current_path, config, failures)
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            scan_structured_value(item, file_path, key_path + [str(idx)], config, failures)


def check_structured_files(files: list[Path], config: dict[str, Any]) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for file_path in files:
        suffix = file_path.suffix.lower()
        if suffix not in {".json", ".jsonl"}:
            continue
        text = read_text(file_path)
        if suffix == ".jsonl":
            for line_no, line in enumerate(text.splitlines(), start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                before = len(failures)
                scan_structured_value(value, file_path, [], config, failures)
                for hit in failures[before:]:
                    hit.setdefault("line", line_no)
        else:
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                continue
            scan_structured_value(value, file_path, [], config, failures)
    return failures[: int(config.get("maxTotalHits") or 30)]


def has_any_term(text: str, terms: list[str]) -> bool:
    lowered = text.lower()
    return any(term.lower() in lowered for term in terms)


def check_numeric_answer_context(files: list[Path], config: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    answer_terms = config.get("answerContextTerms") or []
    benign_terms = config.get("benignNumericContextTerms") or []
    window = int(config.get("numericContextWindow") or 100)

    for file_path in files:
        text = scan_text_with_filename(file_path)
        for match in NUMBER_RE.finditer(text):
            start = max(0, match.start() - window)
            end = min(len(text), match.end() + window)
            context = text[start:end]
            if not has_any_term(context, answer_terms):
                continue
            if has_any_term(context, benign_terms):
                add_hit(
                    warnings,
                    file_path,
                    text,
                    match.start(),
                    "answer-context-number-warning",
                    "A number appears near answer terms, but benign context terms are also present.",
                    context,
                    config,
                )
                continue
            add_hit(
                failures,
                file_path,
                text,
                match.start(),
                "answer-context-number",
                "A concrete number appears near answer/ground-truth language.",
                context,
                config,
            )
    return failures, warnings


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        return emit(
            make_result(
                False,
                "Usage: validate-officeqa-experience-surface.py <validator-input.json> <config.json>",
                [{"kind": "usage-error", "message": "Missing required input or config path."}],
                [],
            )
        )

    input_path = Path(argv[1]).resolve()
    config_path = Path(argv[2]).resolve()
    input_data = load_json(input_path)
    config = load_json(config_path)

    roots = resolve_roots(input_data, config)
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []

    if not roots:
        failures.append({"kind": "no-root", "message": "No experience-workspace root was provided."})
        return emit(make_result(False, "No expert workspace root found.", failures, warnings))

    failures.extend(check_required_files(roots, config))
    files = iter_candidate_files(roots, config)
    failures.extend(check_forbidden_patterns(files, config))
    failures.extend(check_structured_files(files, config))
    numeric_failures, numeric_warnings = check_numeric_answer_context(files, config)
    failures.extend(numeric_failures)
    warnings.extend(numeric_warnings)

    passed = len(failures) == 0
    summary = (
        "OfficeQA expert surface passed: no high-confidence answer leakage was found."
        if passed
        else f"OfficeQA expert surface failed with {len(failures)} blocking issue(s)."
    )
    return emit(make_result(passed, summary, failures, warnings))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
