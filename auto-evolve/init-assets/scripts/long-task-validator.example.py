import json
import os
import sys

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "passed": False,
            "summary": "Missing validator input path.",
            "details": ["The validator expected a JSON input path as argv[1]."],
            "blocking": True,
        }))
        return 1

    payload_path = sys.argv[1]
    with open(payload_path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)

    target_paths = payload.get("targetPaths", [])
    existing = []
    missing = []
    for item in target_paths:
        path_value = item.get("path") if isinstance(item, dict) else None
        if isinstance(path_value, str) and os.path.exists(path_value):
            existing.append(path_value)
        elif isinstance(path_value, str):
            missing.append(path_value)

    passed = len(existing) > 0 and len(missing) == 0
    print(json.dumps({
        "passed": passed,
        "summary": "All target files exist." if passed else "Some target files are missing.",
        "details": [
            f"existing: {len(existing)}",
            f"missing: {len(missing)}",
        ] + [f"missing_path: {item}" for item in missing],
        "blocking": False,
    }, ensure_ascii=False))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
