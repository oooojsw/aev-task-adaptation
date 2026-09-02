from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path


SKILLOPT = Path(r"C:\Users\ZhuanZ\Desktop\SkillOpt")
REPORT_DIR = Path(__file__).resolve().parent

RUNS = {
    "GPT-5.4-mini / no Skill": "spreadsheetbench-gpt54mini-noskill-20260720",
    "GPT-5.4-mini / AEV merge-as-old": "spreadsheetbench-gpt54mini-aev-merged-skill-20260720",
    "GPT-5.4-mini / optMiniMax M2.7": "spreadsheetbench-gpt54mini-optminimax-m27-skill-20260721",
    "GPT-5.4-mini / SkillOpt official": "spreadsheetbench-gpt54mini-skillopt-official-skill-20260721",
    "GPT-5.4 / no Skill": "spreadsheetbench-gpt54-noskill-63384-20260722",
    "GPT-5.4 / AEV merge-as-old": "spreadsheetbench-gpt54-aev-minimax-m27-skill-63384-20260722",
    "GPT-5.4 / optMiniMax M2.7": "spreadsheetbench-gpt54-optminimax-m27-skill-63384-20260722",
    "GPT-5.4 / SkillOpt official": "spreadsheetbench-gpt54-skillopt-official-gpt55-skill-63384-20260722",
    "GPT-5.5 / no Skill": "spreadsheetbench-gpt55-noskill-63384-20260722",
    "GPT-5.5 / AEV merge-as-old (partial)": "spreadsheetbench-gpt55-aev-minimax-m27-skill-63384-20260722",
}

INFRA_MARKERS = (
    "timeout",
    "timed out",
    "rate limit",
    "http 429",
    "http 502",
    "http 503",
    "connection",
    "auth",
    "provider",
    "judge crashed",
    "judge_crash",
)


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8-sig") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
    return rows


def is_infrastructure(row: dict) -> bool:
    text = " ".join(
        str(row.get(key) or "")
        for key in ("error", "fail_reason", "phase")
    ).lower()
    if str(row.get("phase") or "").lower() == "timeout":
        return True
    # The model produced and ran code, but SkillOpt's own preview/evaluator
    # crashed while parsing a dataset answer range. This is not a model miss.
    if "_auto_verify_output" in text or "skillopt\\envs\\spreadsheetbench\\evaluator.py" in text:
        return True
    return any(marker in text for marker in INFRA_MARKERS)


def failure_bucket(row: dict) -> str:
    if int(row.get("hard") or 0) == 1:
        return "passed"
    if is_infrastructure(row):
        return "infrastructure"
    if not bool(row.get("llm_ok", True)):
        return "model_output"
    if not bool(row.get("code_ok", True)):
        return "code_generation"
    if not bool(row.get("exec_ok", True)):
        return "generated_code_runtime"
    return "answer_mismatch"


def main() -> None:
    records = []
    evidence = {}
    for label, dirname in RUNS.items():
        root = SKILLOPT / "outputs" / dirname
        results_path = root / "results.jsonl"
        if not results_path.is_file():
            continue
        rows = load_jsonl(results_path)
        ids = [str(row.get("id") or "").strip() for row in rows]
        duplicates = sorted(item for item, count in Counter(ids).items() if item and count > 1)
        buckets = Counter(failure_bucket(row) for row in rows)
        infra_ids = [str(row.get("id") or "") for row in rows if is_infrastructure(row)]
        hard = sum(int(row.get("hard") or 0) for row in rows)
        soft = sum(float(row.get("soft") or 0.0) for row in rows)
        valid_n = len(rows) - len(infra_ids)
        summary = {}
        summary_path = root / "eval_summary.json"
        if summary_path.is_file():
            summary = json.loads(summary_path.read_text(encoding="utf-8-sig"))
        record = {
            "experiment": label,
            "directory": dirname,
            "rows": len(rows),
            "unique_ids": len(set(ids)),
            "duplicates": ";".join(duplicates),
            "hard_passes": hard,
            "hard_rate_raw": hard / len(rows) if rows else 0.0,
            "soft_rate_raw": soft / len(rows) if rows else 0.0,
            "infrastructure_count": len(infra_ids),
            "valid_n": valid_n,
            "hard_rate_valid": hard / valid_n if valid_n else 0.0,
            "soft_rate_valid": soft / valid_n if valid_n else 0.0,
            "model_output_failures": buckets["model_output"],
            "code_generation_failures": buckets["code_generation"],
            "generated_code_runtime_failures": buckets["generated_code_runtime"],
            "answer_mismatches": buckets["answer_mismatch"],
            "infra_ids": ";".join(infra_ids),
            "skill": str(summary.get("skill") or ""),
        }
        records.append(record)
        evidence[label] = {
            "record": record,
            "failure_buckets": dict(buckets),
            "infrastructure_rows": [row for row in rows if is_infrastructure(row)],
        }

    csv_path = REPORT_DIR / "SpreadsheetBench现有实验审计.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(records[0]))
        writer.writeheader()
        writer.writerows(records)

    evidence_path = REPORT_DIR / "SpreadsheetBench现有实验审计-evidence.json"
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# SpreadsheetBench 现有实验审计",
        "",
        "统一口径：官方 test 280；基础设施失败不当作模型答错，另列有效分母。",
        "",
        "| 实验 | 原始结果 | 基础设施失败 | 有效口径 | 完整性 |",
        "|---|---:|---:|---:|---|",
    ]
    for row in records:
        complete = "完整" if row["rows"] == 280 and row["unique_ids"] == 280 and not row["duplicates"] else "不完整"
        lines.append(
            f"| {row['experiment']} | {row['hard_passes']}/{row['rows']} = {row['hard_rate_raw']:.2%} "
            f"(soft {row['soft_rate_raw']:.2%}) | {row['infrastructure_count']} | "
            f"{row['hard_passes']}/{row['valid_n']} = {row['hard_rate_valid']:.2%} "
            f"(soft {row['soft_rate_valid']:.2%}) | {complete} |"
        )
    lines.extend([
        "",
        "## 当前结论",
        "",
        "- GPT-5.4-mini 和 GPT-5.4 的四组目录均已有 280 行；是否可直接写论文，以本表基础设施列为准。",
        "- GPT-5.5 无 Skill 已完整；AEV merge-as-old 只有 56 行，其余两种 Skill 尚无正式结果。",
        "- 后续不应直接补齐所有组合；先完成基础设施纠错，再选择能够回答论文核心问题的最小实验集。",
    ])
    (REPORT_DIR / "SpreadsheetBench现有实验审计.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
