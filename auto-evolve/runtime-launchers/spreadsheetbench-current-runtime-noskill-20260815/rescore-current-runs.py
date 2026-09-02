import json
from pathlib import Path

from skillopt.envs.spreadsheetbench.evaluator import evaluate, resolve_answer_position
from skillopt.envs.spreadsheetbench.rollout import _find_test_cases


SKILLOPT = Path(r"C:\Users\ZhuanZ\Desktop\SkillOpt")
DATA_ROOT = Path(r"E:\project\experiment\SpreadsheetBench\all_data_912_v0.1")
ITEMS = SKILLOPT / "data" / "spreadsheetbench_split" / "test" / "items.json"
RUNS = {
    "no-skill": SKILLOPT / "outputs" / "spreadsheetbench-minimax27-current-runtime-noskill-20260815",
    "repeat01": SKILLOPT / "outputs" / "spreadsheetbench-three-repeat-minimax27-test280-20260814" / "repeat-01",
    "repeat02": SKILLOPT / "outputs" / "spreadsheetbench-three-repeat-minimax27-test280-20260814" / "repeat-02",
    "repeat03": SKILLOPT / "outputs" / "spreadsheetbench-three-repeat-minimax27-test280-20260814" / "repeat-03",
}


def score_run(items: list[dict], run_dir: Path) -> dict:
    hard = 0
    soft_sum = 0.0
    missing_predictions = 0
    details = []
    for item in items:
        task_id = str(item["id"])
        cases = _find_test_cases(str(DATA_ROOT / item["spreadsheet_path"]))
        answer_position = resolve_answer_position(
            item.get("answer_position", ""), item.get("answer_sheet", "")
        )
        passed = 0
        for case_no, _input_path, answer_path in cases:
            pred_path = run_dir / "predictions" / task_id / f"{case_no}_pred.xlsx"
            if not pred_path.exists():
                missing_predictions += 1
                continue
            result = evaluate(
                str(pred_path), answer_path, item.get("instruction_type", ""), answer_position
            )
            passed += int(bool(result.get("ok")))
        n_cases = len(cases)
        is_hard = bool(n_cases and passed == n_cases)
        hard += int(is_hard)
        soft_sum += passed / n_cases if n_cases else 0.0
        details.append({"id": task_id, "passed": passed, "cases": n_cases, "hard": is_hard})
    return {
        "run_dir": str(run_dir),
        "n_items": len(items),
        "hard_count": hard,
        "hard": hard / len(items),
        "soft": soft_sum / len(items),
        "missing_prediction_files": missing_predictions,
        "details": details,
    }


def main() -> None:
    items = json.loads(ITEMS.read_text(encoding="utf-8"))
    payload = {name: score_run(items, path) for name, path in RUNS.items()}
    output = Path(__file__).with_name("rescore-current-runs-result.json")
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {
        name: {key: value for key, value in result.items() if key != "details"}
        for name, result in payload.items()
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
