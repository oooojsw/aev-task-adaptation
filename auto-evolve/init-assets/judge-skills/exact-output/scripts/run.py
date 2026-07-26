import json
import sys
from pathlib import Path


def read_optional_text(target: Path) -> str:
    if not target.exists():
        return ""
    return target.read_text(encoding="utf-8").strip()


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: run.py <input-json> <output-json>")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    evaluation_path = Path(payload["solveEvaluationPath"])
    actual_path = Path(payload["solveActualOutputPath"])
    expected_path = Path(payload["solveExpectedPath"])

    evaluation = json.loads(evaluation_path.read_text(encoding="utf-8"))
    actual_text = read_optional_text(actual_path)
    expected_text = read_optional_text(expected_path)

    result = {
        "skill": "exact-output",
        "passed": evaluation.get("passed"),
        "summary": evaluation.get("summary"),
        "mismatches": evaluation.get("mismatches", []),
        "actualPreview": actual_text[:240],
        "expectedPreview": expected_text[:240],
        "actualPathExists": actual_path.exists(),
        "expectedPathExists": expected_path.exists(),
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")


if __name__ == "__main__":
    main()
