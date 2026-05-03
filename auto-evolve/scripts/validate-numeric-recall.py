import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from word_text_utils import extract_word_text


def load_json(path_value):
    with open(path_value, "r", encoding="utf-8") as fh:
        return json.load(fh)


def resolve_target_paths(payload, config):
    configured = config.get("targets", [])
    payload_targets = payload.get("targetPaths", [])
    resolved = []
    for target in configured:
        path_value = target.get("targetPath")
        if not path_value:
            label = target.get("label") or target.get("targetLabel")
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
            resolved.append({
                "label": target.get("label") or target.get("targetLabel") or Path(path_value).name,
                "path": str(Path(path_value).resolve()),
            })
    if resolved:
        return resolved
    fallback = []
    for item in payload_targets:
        if isinstance(item, dict) and isinstance(item.get("path"), str):
            fallback.append({
                "label": item.get("label") or Path(item["path"]).name,
                "path": str(Path(item["path"]).resolve()),
            })
    return fallback


def count_unique_numbers(text):
    numbers = re.findall(r'\d+', text)
    return len(set(numbers))


def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "passed": False,
            "summary": "Missing required arguments.",
            "details": ["Usage: python validate-numeric-recall.py <validator-input.json> <config.json>"],
            "blocking": True,
        }, ensure_ascii=False))
        return 1

    payload = load_json(sys.argv[1])
    config = load_json(sys.argv[2])
    threshold = config.get("threshold", 5)
    targets = resolve_target_paths(payload, config)

    if not targets:
        print(json.dumps({
            "passed": False,
            "summary": "No target paths were resolved for numeric recall validation.",
            "details": [],
            "blocking": True,
        }, ensure_ascii=False))
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
            unique_numbers = count_unique_numbers(text)
            if unique_numbers < threshold:
                failures.append(f"{item['label']}:insufficient_recall")
                details.append(f"{item['label']}: only {unique_numbers} unique numbers (threshold: {threshold})")
            else:
                details.append(f"{item['label']}: {unique_numbers} unique numbers (threshold: {threshold})")
        except RuntimeError as exc:
            failures.append(f"{item['label']}:unreadable")
            details.append(f"{item['label']}: cannot extract text ({exc})")

    passed = not failures
    print(json.dumps({
        "passed": passed,
        "summary": "Numeric recall threshold met." if passed else "Some targets have insufficient numeric recall.",
        "details": details,
        "blocking": False,
    }, ensure_ascii=False))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())