import json
import sys
from collections import Counter
from pathlib import Path


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: run.py <input-json> <output-json>")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    tool_failures_path = Path(payload["solveToolFailuresPath"])
    tool_failures = json.loads(tool_failures_path.read_text(encoding="utf-8")) if tool_failures_path.exists() else []
    tool_counts = Counter(item.get("tool", "unknown") for item in tool_failures)
    result = {
        "skill": "tool-failures",
        "count": len(tool_failures),
        "tools": dict(tool_counts),
        "failures": tool_failures,
        "toolFailuresPathExists": tool_failures_path.exists(),
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")


if __name__ == "__main__":
    main()
