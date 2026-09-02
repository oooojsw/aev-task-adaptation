import json
from pathlib import Path

from skillopt.envs.spreadsheetbench.evaluator import evaluate, resolve_answer_position
from skillopt.envs.spreadsheetbench.rollout import _find_test_cases


SKILLOPT = Path(r"C:\Users\ZhuanZ\Desktop\SkillOpt")
DATA_ROOT = Path(r"E:\project\experiment\SpreadsheetBench\all_data_912_v0.1")
OLD_OUT = SKILLOPT / "outputs" / "spreadsheetbench-minimax27-five-condition-20260809" / "no-skill"
ITEMS = SKILLOPT / "data" / "spreadsheetbench_split" / "test" / "items.json"


def main() -> None:
    items = json.loads(ITEMS.read_text(encoding="utf-8"))
    hard = 0
    soft_sum = 0.0
    missing_predictions = 0
    details = []

    for item in items:
        task_id = str(item["id"])
        task_dir = DATA_ROOT / item["spreadsheet_path"]
        cases = _find_test_cases(str(task_dir))
        answer_position = resolve_answer_position(
            item.get("answer_position", ""), item.get("answer_sheet", "")
        )
        passed = 0
        for case_no, _input_path, answer_path in cases:
            pred_path = OLD_OUT / "predictions" / task_id / f"{case_no}_pred.xlsx"
            if not pred_path.exists():
                missing_predictions += 1
                continue
            result = evaluate(
                str(pred_path),
                answer_path,
                item.get("instruction_type", ""),
                answer_position,
            )
            passed += int(bool(result.get("ok")))
        n_cases = len(cases)
        soft = passed / n_cases if n_cases else 0.0
        is_hard = bool(n_cases and passed == n_cases)
        hard += int(is_hard)
        soft_sum += soft
        details.append({"id": task_id, "passed": passed, "cases": n_cases, "hard": is_hard})

    payload = {
        "n_items": len(items),
        "hard_count": hard,
        "hard": hard / len(items),
        "soft": soft_sum / len(items),
        "missing_prediction_files": missing_predictions,
        "details": details,
    }
    output = Path(__file__).with_name("rescore-old-predictions-result.json")
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in payload.items() if key != "details"}, indent=2))


if __name__ == "__main__":
    main()
