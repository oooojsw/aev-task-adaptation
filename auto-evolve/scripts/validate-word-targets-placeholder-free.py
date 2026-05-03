import json
import re
import sys
from pathlib import Path

from word_text_utils import extract_word_text


DEFAULT_PATTERNS = [
    r"【[^【】\r\n]{1,120}】",
    r"ЁО[^ЁОЁП\r\n]{1,120}ЁП",
]


def load_json(path_value: str):
    with open(path_value, "r", encoding="utf-8") as fh:
        return json.load(fh)


def has_orphan_corner_bracket(text: str) -> bool:
    depth = 0
    for char in text:
        if char in ("【", "ЁО"):
            depth += 1
            continue
        if char in ("】", "ЁП"):
            if depth == 0:
                return True
            depth -= 1
    return depth != 0


def build_patterns(config: dict) -> list[re.Pattern]:
    configured = config.get("patterns")
    raw_patterns = configured if isinstance(configured, list) and configured else DEFAULT_PATTERNS
    patterns: list[re.Pattern] = []
    for raw in raw_patterns:
        if not isinstance(raw, str) or not raw.strip():
            continue
        patterns.append(re.compile(raw))
    return patterns


def resolve_target_paths(payload, config):
    configured = config.get("targets", [])
    payload_targets = payload.get("targetPaths", [])
    resolved = []

    for target in configured:
        path_value = target.get("targetPath")
        if not path_value:
            label = target.get("targetLabel")
            role = target.get("targetRole")
            index = target.get("targetIndex")
            match = None
            if isinstance(index, int) and 0 <= index < len(payload_targets):
                match = payload_targets[index]
            else:
                for candidate in payload_targets:
                    if not isinstance(candidate, dict):
                        continue
                    if label and candidate.get("label") == label:
                        match = candidate
                        break
                    if role and candidate.get("role") == role:
                        match = candidate
                        break
            if isinstance(match, dict):
                path_value = match.get("path")
        if isinstance(path_value, str) and path_value.strip():
            resolved.append(
                {
                    "label": target.get("label") or target.get("targetLabel") or Path(path_value).name,
                    "path": str(Path(path_value).resolve()),
                }
            )

    if resolved:
        return resolved

    fallback = []
    for item in payload_targets:
        if isinstance(item, dict) and isinstance(item.get("path"), str):
            fallback.append(
                {
                    "label": item.get("label") or Path(item["path"]).name,
                    "path": str(Path(item["path"]).resolve()),
                }
            )
    return fallback


def main():
    if len(sys.argv) < 3:
        print(
            json.dumps(
                {
                    "passed": False,
                    "summary": "Missing required arguments.",
                    "details": [
                        "Usage: python validate-word-targets-placeholder-free.py <validator-input.json> <config.json>"
                    ],
                    "blocking": True,
                },
                ensure_ascii=False,
            )
        )
        return 1

    payload = load_json(sys.argv[1])
    config = load_json(sys.argv[2])
    patterns = build_patterns(config)
    reject_orphan_brackets = bool(config.get("rejectOrphanBrackets", True))
    targets = resolve_target_paths(payload, config)

    if not targets:
        print(
            json.dumps(
                {
                    "passed": False,
                    "summary": "No target paths were resolved for placeholder validation.",
                    "details": [],
                    "blocking": True,
                },
                ensure_ascii=False,
            )
        )
        return 1

    failures = []
    details = []
    for item in targets:
        target_path = item["path"]
        if not Path(target_path).exists():
            failures.append(f"{item['label']}:missing")
            details.append(f"{item['label']}: missing target path {target_path}")
            continue
        try:
            text = extract_word_text(target_path)
        except RuntimeError as exc:
            failures.append(f"{item['label']}:unreadable")
            details.append(f"{item['label']}: cannot extract text from target ({exc})")
            continue

        matched = [pattern.pattern for pattern in patterns if pattern.search(text)]
        if reject_orphan_brackets and has_orphan_corner_bracket(text):
            matched.append("orphan_corner_bracket")

        if matched:
            failures.append(f"{item['label']}:placeholder")
            details.append(f"{item['label']}: disallowed patterns found {matched}")
        else:
            details.append(f"{item['label']}: placeholder-free")

    passed = not failures
    print(
        json.dumps(
            {
                "passed": passed,
                "summary": "All Word targets are placeholder-free." if passed else "Some Word targets still contain placeholder markers.",
                "details": details,
                "blocking": False,
            },
            ensure_ascii=False,
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
