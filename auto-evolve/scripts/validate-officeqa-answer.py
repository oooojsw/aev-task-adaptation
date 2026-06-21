import argparse
import importlib.util
import json
import math
from pathlib import Path


def load_reward_module(path: Path):
    spec = importlib.util.spec_from_file_location("officeqa_reward", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load reward module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_payload(path_text: str | None) -> dict:
    if not path_text:
        return {}
    path = Path(path_text)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8-sig", errors="ignore"))
    except Exception:
        return {}


def infer_task_dir(payload: dict) -> Path | None:
    for item in payload.get("materials", []):
        if not isinstance(item, dict):
            continue
        candidate = item.get("path")
        role = item.get("role")
        if isinstance(candidate, str) and role == "human-guidance":
            path = Path(candidate)
            if path.exists():
                return path.parent
    for item in payload.get("materials", []):
        if not isinstance(item, dict):
            continue
        candidate = item.get("path")
        if isinstance(candidate, str):
            path = Path(candidate)
            if path.exists():
                return path.parent.parent if path.parent.name == "materials" else path.parent
    return None


def payload_output_candidates(payload: dict) -> list[Path]:
    candidates: list[Path] = []
    for key in ("targetPaths",):
        for item in payload.get(key, []):
            if not isinstance(item, dict):
                continue
            value = item.get("path")
            if isinstance(value, str) and value.strip():
                candidates.append(Path(value))
    for value in payload.get("expectedArtifacts", []):
        if isinstance(value, str) and value.strip():
            candidates.append(Path(value))
    return candidates


def resolve_candidate_path(candidate: str, payload: dict) -> Path:
    raw = Path(candidate)
    if raw.is_absolute():
        return raw
    raw_name = raw.name.lower()
    for item in payload_output_candidates(payload):
        if item.name.lower() == raw_name and item.exists():
            return item
    for item in payload_output_candidates(payload):
        if item.name.lower() == raw_name:
            return item
    task_dir = infer_task_dir(payload)
    if task_dir is not None:
        task_relative = task_dir / candidate
        if task_relative.exists():
            return task_relative
    return raw


def resolve_answer_path(answer_path: str, payload: dict) -> Path:
    raw = Path(answer_path)
    if raw.is_absolute():
        return raw
    task_dir = infer_task_dir(payload)
    if task_dir is not None:
        task_relative = (task_dir / answer_path).resolve()
        if task_relative.exists():
            return task_relative
    return raw.resolve()


def parse_structured_answer(text: str):
    stripped = text.strip()
    if not stripped or stripped[0] not in "[{":
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return None


def structured_answers_equal(expected, predicted, tolerance: float) -> bool:
    if isinstance(expected, bool) or isinstance(predicted, bool):
        return expected is predicted
    if isinstance(expected, (int, float)) and isinstance(predicted, (int, float)):
        expected_number = float(expected)
        predicted_number = float(predicted)
        if not math.isfinite(expected_number) or not math.isfinite(predicted_number):
            return expected_number == predicted_number
        if expected_number == 0:
            return predicted_number == 0
        return abs(expected_number - predicted_number) / abs(expected_number) <= tolerance
    if isinstance(expected, str) and isinstance(predicted, str):
        return expected.strip().casefold() == predicted.strip().casefold()
    if isinstance(expected, list) and isinstance(predicted, list):
        return len(expected) == len(predicted) and all(
            structured_answers_equal(left, right, tolerance)
            for left, right in zip(expected, predicted)
        )
    if isinstance(expected, dict) and isinstance(predicted, dict):
        return set(expected) == set(predicted) and all(
            structured_answers_equal(expected[key], predicted[key], tolerance)
            for key in expected
        )
    return expected == predicted


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("payload_json", nargs="?")
    parser.add_argument("--answer-path", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--reward", required=True)
    parser.add_argument("--tolerance", type=float, default=0.01)
    args, _unknown = parser.parse_known_args()

    payload = load_payload(args.payload_json)
    candidate_path = resolve_candidate_path(args.candidate, payload)
    if not candidate_path.exists():
        raise SystemExit(f"Missing candidate answer file: {candidate_path}")

    answer_file = resolve_answer_path(args.answer_path, payload)
    if not answer_file.exists():
        raise SystemExit(f"Missing private answer file: {answer_file}")

    ground_truth_text = answer_file.read_text(encoding="utf-8-sig", errors="ignore").strip()
    predicted = candidate_path.read_text(encoding="utf-8-sig", errors="ignore").strip()
    expected_structured = parse_structured_answer(ground_truth_text)
    predicted_structured = parse_structured_answer(predicted)
    if expected_structured is not None and predicted_structured is not None:
        passed = structured_answers_equal(expected_structured, predicted_structured, args.tolerance)
        print(json.dumps({
            "passed": passed,
            "score": 1.0 if passed else 0.0,
            "method": "structured-json-semantic",
            "tolerance": args.tolerance,
        }, ensure_ascii=False))
        if not passed:
            raise SystemExit(1)
        return

    reward = load_reward_module(Path(args.reward))
    score = reward.score_answer(ground_truth_text, predicted, args.tolerance)
    if score < 1.0:
        print(json.dumps({
            "passed": False,
            "score": score,
            "method": "officeqa-reward",
            "tolerance": args.tolerance,
            "expected": ground_truth_text,
            "predicted": predicted,
        }, ensure_ascii=False))
        raise SystemExit(1)
    print(json.dumps({
        "passed": True,
        "score": score,
        "method": "officeqa-reward",
        "tolerance": args.tolerance,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
