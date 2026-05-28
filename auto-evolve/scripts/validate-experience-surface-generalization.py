import json
import re
import sys
from pathlib import Path


DEFAULT_ALLOWED_EXTENSIONS = [".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"]
DEFAULT_ROOT_ROLES = ["experience-workspace"]


def load_json(path_value: str):
    with open(path_value, "r", encoding="utf-8-sig") as fh:
        return json.load(fh)


def iter_surface_roots(payload: dict, config: dict) -> list[Path]:
    target_paths = payload.get("targetPaths", [])
    configured_roles = config.get("rootRoles", DEFAULT_ROOT_ROLES)
    configured_labels = config.get("rootLabels", [])
    configured_paths = config.get("rootPaths", [])
    roots: list[Path] = []

    for raw_path in configured_paths:
        if isinstance(raw_path, str) and raw_path.strip():
            roots.append(Path(raw_path).resolve())

    for item in target_paths:
        if not isinstance(item, dict):
            continue
        raw_path = item.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            continue
        label = item.get("label")
        role = item.get("role")
        if label in configured_labels or role in configured_roles:
            roots.append(Path(raw_path).resolve())

    unique: list[Path] = []
    seen = set()
    for root in roots:
        key = str(root)
        if key in seen:
            continue
        seen.add(key)
        unique.append(root)
    return unique


def iter_candidate_files(roots: list[Path], config: dict) -> tuple[list[Path], list[dict]]:
    allowed_extensions = {
        ext.lower() for ext in config.get("allowedExtensions", DEFAULT_ALLOWED_EXTENSIONS) if isinstance(ext, str)
    }
    ignore_path_substrings = [
        str(item).lower() for item in config.get("ignorePathSubstrings", []) if isinstance(item, str) and item.strip()
    ]
    candidates: list[Path] = []
    ignored: list[dict] = []

    for root in roots:
        if not root.exists():
            continue
        if root.is_file():
            items = [root]
        else:
            items = [item for item in root.rglob("*") if item.is_file()]
        for item in items:
            item_str = str(item).lower()
            if ignore_path_substrings:
                matched_token = next((tok for tok in ignore_path_substrings if tok in item_str), None)
                if matched_token:
                    ignored.append({"path": str(item), "reason": f"matched ignorePathSubstring: {matched_token}"})
                    continue
            if item.suffix.lower() not in allowed_extensions:
                ignored.append({"path": str(item), "reason": f"extension not allowed: {item.suffix}"})
                continue
            candidates.append(item)

    unique_candidates: list[Path] = []
    seen = set()
    for item in candidates:
        key = str(item)
        if key in seen:
            continue
        seen.add(key)
        unique_candidates.append(item)
    return unique_candidates, ignored


def compile_patterns(config: dict):
    compiled = []
    for raw in config.get("forbiddenPatterns", []):
        if not isinstance(raw, dict):
            continue
        pattern = raw.get("pattern")
        if not isinstance(pattern, str) or not pattern.strip():
            continue
        label = raw.get("label") if isinstance(raw.get("label"), str) and raw.get("label").strip() else pattern
        flags = 0
        raw_flags = raw.get("flags", [])
        if isinstance(raw_flags, list):
            for flag in raw_flags:
                if flag == "IGNORECASE":
                    flags |= re.IGNORECASE
        compiled.append((label, re.compile(pattern, flags)))
    return compiled

def check_required_files(roots: list[Path], config: dict):
    required = [str(item).strip() for item in config.get("requiredFiles", []) if str(item).strip()]
    if not required:
        return []
    misses = []
    # Root-level relative checks: any root can satisfy each required file.
    for rel in required:
        found = False
        for root in roots:
            target = (root / rel).resolve()
            if target.exists() and target.is_file():
                found = True
                break
        if not found:
            misses.append(f"missing required file: {rel}")
    return misses

def check_required_dirs(roots: list[Path], config: dict):
    required = [str(item).strip() for item in config.get("requiredDirs", []) if str(item).strip()]
    if not required:
        return []
    misses = []
    for rel in required:
        found = False
        for root in roots:
            target = (root / rel).resolve()
            if target.exists() and target.is_dir():
                found = True
                break
        if not found:
            misses.append(f"missing required directory: {rel}")
    return misses

def check_required_sections(roots: list[Path], config: dict):
    required = config.get("requiredSections", [])
    if not isinstance(required, list) or not required:
        return []
    misses = []
    for item in required:
        if not isinstance(item, dict):
            continue
        rel = item.get("file")
        sec = item.get("sections", [])
        if not isinstance(rel, str) or not rel.strip():
            continue
        if not isinstance(sec, list):
            continue
        values = [str(v).strip() for v in sec if str(v).strip()]
        if not values:
            continue
        text = None
        for root in roots:
            target = (root / rel).resolve()
            if target.exists() and target.is_file():
                text = target.read_text(encoding="utf-8", errors="ignore")
                break
        if text is None:
            misses.append(f"required section file not found: {rel}")
            continue
        for row in values:
            if row not in text:
                misses.append(f"missing required section: {rel} -> {row}")
    return misses


def trim_line(text: str, limit: int = 180):
    normalized = " ".join(text.strip().split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 3] + "..."


def find_hits(file_path: Path, text: str, config: dict, compiled_patterns: list[tuple[str, re.Pattern]]):
    hits: list[str] = []
    max_hits_per_file = int(config.get("maxHitsPerFile", 4))

    for raw in config.get("forbiddenLiterals", []):
        if len(hits) >= max_hits_per_file:
            break
        if isinstance(raw, dict):
            value = raw.get("value")
            label = raw.get("label") if isinstance(raw.get("label"), str) and raw.get("label").strip() else value
        else:
            value = raw
            label = raw
        if not isinstance(value, str) or not value:
            continue
        if value not in text:
            continue
        line = next((line for line in text.splitlines() if value in line), value)
        hits.append(f"{file_path}: {label} -> {trim_line(line)}")

    for label, pattern in compiled_patterns:
        if len(hits) >= max_hits_per_file:
            break
        match = pattern.search(text)
        if not match:
            continue
        line = next((line for line in text.splitlines() if match.group(0) in line), match.group(0))
        hits.append(f"{file_path}: {label} -> {trim_line(line)}")

    return hits


def main():
    if len(sys.argv) < 3:
        print(
            json.dumps(
                {
                    "passed": False,
                    "summary": "Missing required arguments.",
                    "details": [
                        "Usage: python validate-experience-surface-generalization.py <validator-input.json> <config.json>"
                    ],
                    "blocking": True,
                },
                ensure_ascii=False,
            )
        )
        return 1

    payload = load_json(sys.argv[1])
    config = load_json(sys.argv[2])
    roots = iter_surface_roots(payload, config)
    if not roots:
        print(
            json.dumps(
                {
                    "passed": False,
                    "summary": "No formal experience roots were resolved for generalization validation.",
                    "details": [],
                    "blocking": True,
                },
                ensure_ascii=False,
            )
        )
        return 1

    files, ignored = iter_candidate_files(roots, config)
    compiled_patterns = compile_patterns(config)
    details = [f"scanned_roots: {len(roots)}", f"scanned_files: {len(files)}"]
    required_misses = []
    required_misses.extend(check_required_files(roots, config))
    required_misses.extend(check_required_dirs(roots, config))
    required_misses.extend(check_required_sections(roots, config))
    if ignored:
        details.append(f"skipped_files: {len(ignored)}")
        if config.get("warnOnIgnoredHits", False):
            for entry in ignored:
                details.append(f"  skip: {entry['path']} ({entry['reason']})")
    all_hits: list[str] = []
    max_total_hits = int(config.get("maxTotalHits", 12))

    for file_path in files:
        try:
            text = file_path.read_text(encoding="utf-8", errors="ignore")
        except OSError as exc:
            details.append(f"skip_unreadable: {file_path} ({exc})")
            continue
        file_hits = find_hits(file_path, text, config, compiled_patterns)
        for item in file_hits:
            if len(all_hits) >= max_total_hits:
                break
            all_hits.append(item)
        if len(all_hits) >= max_total_hits:
            break

    passed = len(all_hits) == 0 and len(required_misses) == 0
    details.extend(required_misses)
    details.extend(all_hits if all_hits else ["no task-answer literals detected in the formal experience surface"])
    print(
        json.dumps(
            {
                "passed": passed,
                "summary": (
                    "Formal experience surface stays answer-agnostic."
                    if passed
                    else "Formal experience surface still contains hardcoded task-answer content."
                ),
                "details": details,
                "blocking": False,
            },
            ensure_ascii=False,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
