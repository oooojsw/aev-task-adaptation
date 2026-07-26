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
    events_path = Path(payload["solveEventsPath"])
    events = json.loads(events_path.read_text(encoding="utf-8")) if events_path.exists() else []

    tool_counter = Counter()
    read_counter = 0
    empty_output_signals = 0

    for event in events:
        if event.get("type") == "tool_call":
            tool_name = str(event.get("tool") or "unknown")
            tool_counter[tool_name] += 1
            if tool_name == "read":
                read_counter += 1
            output = event.get("output")
            if isinstance(output, str) and not output.strip():
                empty_output_signals += 1

    result = {
        "skill": "session-behavior",
        "toolCounts": dict(tool_counter),
        "readCount": read_counter,
        "emptyOutputSignals": empty_output_signals,
        "repeatedReadSignal": read_counter >= 5,
        "eventsPathExists": events_path.exists(),
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")


if __name__ == "__main__":
    main()
