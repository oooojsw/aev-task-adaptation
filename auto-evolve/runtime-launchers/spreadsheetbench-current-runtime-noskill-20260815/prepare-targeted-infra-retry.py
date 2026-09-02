import json
import os
import shutil
from pathlib import Path


RUN_DIR = Path(
    r"C:\Users\ZhuanZ\Desktop\SkillOpt\outputs\spreadsheetbench-minimax27-corrected-controls-20260815\skillopt-official"
)
BACKUP_DIR = RUN_DIR / "infra-retry-backup-20260816"


def is_retryable_infrastructure_failure(row: dict) -> bool:
    reason = str(row.get("fail_reason", ""))
    return row.get("llm_ok") is False and reason.startswith("llm-call-failed:")


def main() -> None:
    results_path = RUN_DIR / "results.jsonl"
    summary_path = RUN_DIR / "eval_summary.json"
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    rows = [json.loads(line) for line in results_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    retry_rows = [row for row in rows if is_retryable_infrastructure_failure(row)]
    retained_rows = [row for row in rows if not is_retryable_infrastructure_failure(row)]
    if len(rows) != 280 or len(retry_rows) != 19 or len(retained_rows) != 261:
        raise RuntimeError(
            f"Unexpected retry cohort: total={len(rows)} retry={len(retry_rows)} retained={len(retained_rows)}"
        )

    shutil.copy2(results_path, BACKUP_DIR / "results-before-retry.jsonl")
    if summary_path.exists():
        os.replace(summary_path, BACKUP_DIR / "eval-summary-before-retry.json")

    temp_path = results_path.with_suffix(".jsonl.retry-tmp")
    temp_path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in retained_rows),
        encoding="utf-8",
    )
    os.replace(temp_path, results_path)

    manifest = {
        "originalCount": len(rows),
        "retainedCount": len(retained_rows),
        "retryCount": len(retry_rows),
        "retryUIDs": [str(row.get("id", "")) for row in retry_rows],
        "reason": "MiniMax transport failures only; model-answer failures retained",
    }
    (BACKUP_DIR / "retry-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
