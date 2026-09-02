from __future__ import annotations

import csv
import json
import math
import random
from collections import Counter
from pathlib import Path


ROOT = Path(r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest")
SKILLOPT = Path(r"C:\Users\ZhuanZ\Desktop\SkillOpt")
OUT = ROOT / "auto-evolve/进度报告/2026-08-04-OfficeQA论文统计"

RUNS = {
    "GPT-5.4-mini": {
        "无 Skill": "spreadsheetbench-gpt54mini-noskill-20260720",
        "AEV merge-as-old": "spreadsheetbench-gpt54mini-aev-merged-skill-20260720",
        "optMiniMax M2.7 Skill": "spreadsheetbench-gpt54mini-optminimax-m27-skill-20260721",
        "SkillOpt 官方 Skill": "spreadsheetbench-gpt54mini-skillopt-official-skill-20260721",
    },
    "GPT-5.4": {
        "无 Skill": "spreadsheetbench-gpt54-noskill-63384-20260722",
        "AEV merge-as-old": "spreadsheetbench-gpt54-aev-minimax-m27-skill-63384-20260722",
        "optMiniMax M2.7 Skill": "spreadsheetbench-gpt54-optminimax-m27-skill-63384-20260722",
        "SkillOpt 官方 Skill": "spreadsheetbench-gpt54-skillopt-official-gpt55-skill-63384-20260722",
    },
}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def is_infra(row: dict) -> bool:
    phase = str(row.get("phase") or "").lower()
    text = " ".join(str(row.get(key) or "") for key in ("phase", "fail_reason", "error")).lower()
    if phase == "timeout":
        return True
    if "_auto_verify_output" in text or "skillopt\\envs\\spreadsheetbench\\evaluator.py" in text:
        return True
    markers = (
        "timed out",
        "unicodeencodeerror",
        "rate limit",
        "http 429",
        "http 502",
        "http 503",
        "connection error",
        "auth_unavailable",
    )
    return any(marker in text for marker in markers)


def wilson(k: int, n: int) -> tuple[float, float]:
    if not n:
        return 0.0, 0.0
    z = 1.959963984540054
    p = k / n
    den = 1 + z * z / n
    center = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return center - half, center + half


def exact_mcnemar(b: int, c: int) -> float:
    n = b + c
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(0, min(b, c) + 1)) / (2**n)
    return min(1.0, 2 * tail)


def bootstrap_delta(pairs: list[tuple[int, int]], seed: int, samples: int = 20_000) -> tuple[float, float]:
    rng = random.Random(seed)
    n = len(pairs)
    values = []
    for _ in range(samples):
        delta = 0
        for _ in range(n):
            left, right = pairs[rng.randrange(n)]
            delta += right - left
        values.append(delta / n)
    values.sort()
    return values[int(samples * 0.025)], values[int(samples * 0.975)]


def write_csv(name: str, rows: list[dict]) -> None:
    with (OUT / name).open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


loaded: dict[str, dict[str, dict[str, dict]]] = {}
matrix_rows = []
infra_rows = []
for model, conditions in RUNS.items():
    loaded[model] = {}
    for condition, dirname in conditions.items():
        path = SKILLOPT / "outputs" / dirname / "results.jsonl"
        rows = read_jsonl(path)
        by_id = {str(row.get("id")): row for row in rows}
        if len(rows) != 280 or len(by_id) != 280:
            raise SystemExit(f"Expected 280 unique rows: {path}")
        loaded[model][condition] = by_id
        infra = [row for row in rows if is_infra(row)]
        valid = [row for row in rows if not is_infra(row)]
        hard = sum(int(row.get("hard") or 0) for row in valid)
        soft = sum(float(row.get("soft") or 0) for row in valid)
        lo, hi = wilson(hard, len(valid))
        matrix_rows.append(
            {
                "测试模型": model,
                "条件": condition,
                "原始题数": len(rows),
                "基础设施失败": len(infra),
                "有效题数": len(valid),
                "hard通过": hard,
                "hard成功率": hard / len(valid),
                "hard_95CI_low": lo,
                "hard_95CI_high": hi,
                "soft成功率": soft / len(valid),
                "结果目录": str(path.parent),
            }
        )
        for row in infra:
            infra_rows.append(
                {
                    "测试模型": model,
                    "条件": condition,
                    "task_id": row.get("id"),
                    "phase": row.get("phase"),
                    "原因": row.get("fail_reason") or row.get("error"),
                    "处理": "从该条件有效分母及逐题配对中排除",
                }
            )

paired_rows = []
case_rows = []
comparisons = [
    ("无 Skill", "AEV merge-as-old"),
    ("无 Skill", "optMiniMax M2.7 Skill"),
    ("无 Skill", "SkillOpt 官方 Skill"),
    ("AEV merge-as-old", "optMiniMax M2.7 Skill"),
    ("AEV merge-as-old", "SkillOpt 官方 Skill"),
]
for model, conditions in loaded.items():
    for comparison_no, (left_name, right_name) in enumerate(comparisons):
        left = conditions[left_name]
        right = conditions[right_name]
        ids = sorted(set(left) & set(right))
        ids = [uid for uid in ids if not is_infra(left[uid]) and not is_infra(right[uid])]
        pairs = [(int(left[uid].get("hard") or 0), int(right[uid].get("hard") or 0)) for uid in ids]
        both = sum(a == 1 and b == 1 for a, b in pairs)
        left_only = sum(a == 1 and b == 0 for a, b in pairs)
        right_only = sum(a == 0 and b == 1 for a, b in pairs)
        neither = sum(a == 0 and b == 0 for a, b in pairs)
        delta_cases = right_only - left_only
        low, high = bootstrap_delta(pairs, seed=5400 + comparison_no + (1 if model == "GPT-5.4" else 0))
        paired_rows.append(
            {
                "测试模型": model,
                "对比": f"{right_name} vs {left_name}",
                "共同有效题数": len(ids),
                "都成功": both,
                "仅左成功": left_only,
                "仅右成功": right_only,
                "都失败": neither,
                "净提升题数": delta_cases,
                "净提升百分点": delta_cases / len(ids),
                "配对bootstrap_95CI_low": low,
                "配对bootstrap_95CI_high": high,
                "exact_McNemar_p": exact_mcnemar(left_only, right_only),
            }
        )
        for uid in ids:
            case_rows.append(
                {
                    "测试模型": model,
                    "对比": f"{right_name} vs {left_name}",
                    "task_id": uid,
                    "左": int(left[uid].get("hard") or 0),
                    "右": int(right[uid].get("hard") or 0),
                    "变化": int(right[uid].get("hard") or 0) - int(left[uid].get("hard") or 0),
                }
            )

# The headline matrix uses one fixed cohort per model so every condition has
# exactly the same denominator. Condition-specific valid rates remain auditable
# in SpreadsheetBench现有实验审计.csv.
matrix_rows = []
for model, conditions in loaded.items():
    common_ids = sorted(set.intersection(*(set(rows) for rows in conditions.values())))
    common_ids = [
        uid
        for uid in common_ids
        if all(not is_infra(rows[uid]) for rows in conditions.values())
    ]
    for condition, rows in conditions.items():
        hard = sum(int(rows[uid].get("hard") or 0) for uid in common_ids)
        soft = sum(float(rows[uid].get("soft") or 0) for uid in common_ids)
        lo, hi = wilson(hard, len(common_ids))
        matrix_rows.append(
            {
                "测试模型": model,
                "条件": condition,
                "原始题数": 280,
                "基础设施失败": 280 - len(common_ids),
                "有效题数": len(common_ids),
                "hard通过": hard,
                "hard成功率": hard / len(common_ids),
                "hard_95CI_low": lo,
                "hard_95CI_high": hi,
                "soft成功率": soft / len(common_ids),
                "结果目录": str(SKILLOPT / "outputs" / RUNS[model][condition]),
            }
        )

# Holm correction controls false positives across all ten planned pairwise tests.
ordered = sorted(enumerate(paired_rows), key=lambda item: item[1]["exact_McNemar_p"])
running_max = 0.0
for rank, (index, row) in enumerate(ordered):
    adjusted = min(1.0, row["exact_McNemar_p"] * (len(ordered) - rank))
    running_max = max(running_max, adjusted)
    paired_rows[index]["Holm校正p"] = running_max

skillopt_summary = json.loads(
    (SKILLOPT / "outputs/spreadsheetbench-optminimax-m27-training-20260719-140245/summary.json").read_text(encoding="utf-8-sig")
)
tokens = skillopt_summary["token_summary"]["_total"]
cost_rows = [
    {
        "训练/合并": "AEV MiniMax M2.7 长程训练",
        "规模": "官方 train80；69 verified_success，4 failed，7 round-limit",
        "calls": "未知",
        "prompt_tokens": "未知",
        "completion_tokens": "未知",
        "total_tokens": "未知",
        "wall_time_s": "未知",
        "说明": "历史运行早于完整分角色 token 账本；cost-ledger 为空，不能记作 0",
    },
    {
        "训练/合并": "optMiniMax M2.7 SkillOpt 训练",
        "规模": "train80 / val40；8 steps；2 accept / 6 reject；best 14/40",
        "calls": tokens["calls"],
        "prompt_tokens": tokens["prompt_tokens"],
        "completion_tokens": tokens["completion_tokens"],
        "total_tokens": tokens["total_tokens"],
        "wall_time_s": skillopt_summary["total_wall_time_s"],
        "说明": "SkillOpt summary 完整记录",
    },
    {
        "训练/合并": "AEV merge-as-old",
        "规模": "69 个成功 Skill，16 -> 4 -> 1 分层合并",
        "calls": "未知",
        "prompt_tokens": "未知",
        "completion_tokens": "未知",
        "total_tokens": "未知",
        "wall_time_s": "未知",
        "说明": "历史合并未保存 provider usage，不能记作 0",
    },
]

write_csv("SpreadsheetBench表1-总矩阵.csv", matrix_rows)
write_csv("SpreadsheetBench表2-逐题配对显著性.csv", paired_rows)
write_csv("SpreadsheetBench表3-逐题配对明细.csv", case_rows)
write_csv("SpreadsheetBench表4-基础设施审计.csv", infra_rows)
write_csv("SpreadsheetBench表5-训练成本.csv", cost_rows)

matrix_lookup = {(row["测试模型"], row["条件"]): row for row in matrix_rows}
lines = [
    "# SpreadsheetBench 论文级五表",
    "",
    "统一口径：官方 test 280；使用 SkillOpt 原生 SpreadsheetBench 执行与裁判链路。平台/裁判崩溃不算模型答错，逐题比较只使用双方共同有效的题。",
    "",
    "## 表 1：总矩阵",
    "",
    "| 测试模型 | 无 Skill | AEV merge-as-old | optMiniMax M2.7 Skill | SkillOpt 官方 Skill |",
    "|---|---:|---:|---:|---:|",
]
for model in RUNS:
    cells = []
    for condition in RUNS[model]:
        row = matrix_lookup[(model, condition)]
        cells.append(
            f"{row['hard通过']}/{row['有效题数']} = {row['hard成功率']:.2%} "
            f"[{row['hard_95CI_low']:.2%}, {row['hard_95CI_high']:.2%}]"
        )
    lines.append(f"| {model} | " + " | ".join(cells) + " |")

lines.extend([
    "",
    "## 表 2：关键配对结论",
    "",
    "| 测试模型 | 对比 | 共同有效题数 | 净提升 | 提升百分点 | 95% 配对区间 | McNemar p | Holm p |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
])
for row in paired_rows:
    lines.append(
        f"| {row['测试模型']} | {row['对比']} | {row['共同有效题数']} | {row['净提升题数']:+d} | "
        f"{row['净提升百分点']:+.2%} | [{row['配对bootstrap_95CI_low']:.2%}, "
        f"{row['配对bootstrap_95CI_high']:.2%}] | {row['exact_McNemar_p']:.4g} | {row['Holm校正p']:.4g} |"
    )

lines.extend([
    "",
    "## 表 3：逐题差异",
    "",
    f"完整逐题配对共 {len(case_rows)} 行，见 `SpreadsheetBench表3-逐题配对明细.csv`。",
    "",
    "## 表 4：基础设施审计",
    "",
    f"共记录 {len(infra_rows)} 个运行-题目级基础设施失败。`60-7` 与 `283-32` 是 SkillOpt 自身裁判解析答案位置时崩溃，并非模型答错；其他为超时或 Windows 编码错误。",
    "",
    "## 表 5：训练成本",
    "",
    f"SkillOpt 的 optMiniMax 训练完整记录为 {tokens['total_tokens']:,} tokens、{tokens['calls']:,} 次调用、{skillopt_summary['total_wall_time_s'] / 3600:.2f} 小时。AEV 历史 SpreadsheetBench 训练与 merge-as-old 没有完整 token 记录，因此标记未知。",
    "",
    "## 大白话结论",
    "",
    "- AEV merge-as-old 相比无 Skill，在 GPT-5.4-mini 和 GPT-5.4 上都明显更好，说明 AEV 训练出的经验可以跨测试模型发挥作用。",
    "- SkillOpt 官方 GPT-5.5 Skill 在这两个测试模型上分数最高，但它的训练模型和训练成本与 AEV 不同，不能把这一列直接写成合并算法胜负。",
    "- 同训练模型的公平比较应优先看 AEV merge-as-old 与 optMiniMax M2.7 Skill；详细显著性以表 2 为准。",
    "- GPT-5.5 的 SpreadsheetBench 四组矩阵没有补齐，但对论文当前核心结论不是必要条件；已有两个完整测试模型比继续烧 784 次调用更划算。",
])
(OUT / "SpreadsheetBench论文级五表.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(json.dumps({"matrix": len(matrix_rows), "paired": len(paired_rows), "cases": len(case_rows), "infra": len(infra_rows)}))
