import argparse
import importlib.util
import json
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


def resolve_candidate_path(candidate: str, payload: dict) -> Path:
    raw = Path(candidate)
    if raw.is_absolute():
        return raw
    task_dir = infer_task_dir(payload)
    if task_dir is not None:
        task_relative = task_dir / candidate
        if task_relative.exists():
            return task_relative
    return raw


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("payload_json", nargs="?")
    parser.add_argument("--ground-truth", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--reward", required=True)
    parser.add_argument("--tolerance", type=float, default=0.01)
    args, _unknown = parser.parse_known_args()

    payload = load_payload(args.payload_json)
    candidate_path = resolve_candidate_path(args.candidate, payload)
    if not candidate_path.exists():
        raise SystemExit(f"Missing candidate answer file: {candidate_path}")

    predicted = candidate_path.read_text(encoding="utf-8-sig", errors="ignore").strip()
    reward = load_reward_module(Path(args.reward))
    score = reward.score_answer(args.ground_truth, predicted, args.tolerance)
    if score < 1.0:
        raise SystemExit(
            "OfficeQA answer validation failed.\n"
            f"Expected: {args.ground_truth}\n"
            f"Predicted: {predicted}\n"
            f"Tolerance: {args.tolerance}\n"
            f"Score: {score}"
        )
    print("OfficeQA answer validation passed.")


if __name__ == "__main__":
    main()
