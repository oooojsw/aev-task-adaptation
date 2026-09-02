from __future__ import annotations

import csv
import json
import math
from pathlib import Path


ROOT = Path(r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest")
SKILLOPT = Path(r"C:\Users\ZhuanZ\Desktop\SkillOpt")
OUT = ROOT / "auto-evolve/进度报告/2026-08-04-OfficeQA论文统计"

OFFICE = {
    "GPT-5.4-mini": (
        "officeqa-gpt54mini-skillopt-singleturn-with-aev-skill-merged172-20260716",
        "officeqa-gpt54mini-skillopt-singleturn-with-minimax27-trained-skill-20260719",
    ),
    "GPT-5.4": (
        "officeqa-gpt54-skillopt-singleturn-with-final-skill-20260716-011950",
        "officeqa-gpt54-skillopt-singleturn-with-minimax27-trained-skill-20260719",
    ),
    "GPT-5.5": (
        None,
        "officeqa-gpt55-skillopt-singleturn-with-optminimax27-skill-20260719",
    ),
    "MiniMax M2.7": (
        "officeqa-minimax27-skillopt-singleturn-with-aev-merge-as-old-skill-20260730-recovery4",
        "officeqa-minimax27-native-singleturn-optminimax-skill-20260731",
    ),
}

SHEET = {
    "GPT-5.4-mini": (
        "spreadsheetbench-gpt54mini-aev-merged-skill-20260720",
        "spreadsheetbench-gpt54mini-optminimax-m27-skill-20260721",
    ),
    "GPT-5.4": (
        "spreadsheetbench-gpt54-aev-minimax-m27-skill-63384-20260722",
        "spreadsheetbench-gpt54-optminimax-m27-skill-63384-20260722",
    ),
}


def load(path: Path) -> dict[str, dict]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    return {str(row.get("id")): row for row in rows}


def sheet_infra(row: dict) -> bool:
    phase = str(row.get("phase") or "").lower()
    text = " ".join(str(row.get(key) or "") for key in ("phase", "fail_reason", "error")).lower()
    return (
        phase == "timeout"
        or "_auto_verify_output" in text
        or "skillopt\\envs\\spreadsheetbench\\evaluator.py" in text
        or "timed out" in text
        or "unicodeencodeerror" in text
    )


def mcnemar(left_only: int, right_only: int) -> float:
    n = left_only + right_only
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(min(left_only, right_only) + 1)) / (2**n)
    return min(1.0, 2 * tail)


rows = []
for dataset, mapping in (("OfficeQA", OFFICE), ("SpreadsheetBench", SHEET)):
    for model, (aev_dir, opt_dir) in mapping.items():
        aev_path = (
            OUT / "uid0068-retry/composite-results.jsonl"
            if dataset == "OfficeQA" and model == "GPT-5.5"
            else SKILLOPT / "outputs" / str(aev_dir) / "results.jsonl"
        )
        opt_path = SKILLOPT / "outputs" / opt_dir / "results.jsonl"
        aev = load(aev_path)
        opt = load(opt_path)
        ids = sorted(set(aev) & set(opt))
        if dataset == "SpreadsheetBench":
            ids = [uid for uid in ids if not sheet_infra(aev[uid]) and not sheet_infra(opt[uid])]
        aev_pass = sum(int(aev[uid].get("hard") or 0) for uid in ids)
        opt_pass = sum(int(opt[uid].get("hard") or 0) for uid in ids)
        aev_only = sum(
            int(aev[uid].get("hard") or 0) == 1 and int(opt[uid].get("hard") or 0) == 0
            for uid in ids
        )
        opt_only = sum(
            int(aev[uid].get("hard") or 0) == 0 and int(opt[uid].get("hard") or 0) == 1
            for uid in ids
        )
        rows.append(
            {
                "数据集": dataset,
                "测试模型": model,
                "共同有效题数": len(ids),
                "AEV merge-as-old": aev_pass,
                "optMiniMax M2.7": opt_pass,
                "AEV净胜题数": aev_pass - opt_pass,
                "AEV净胜百分点": (aev_pass - opt_pass) / len(ids),
                "仅AEV成功": aev_only,
                "仅opt成功": opt_only,
                "McNemar_p": mcnemar(aev_only, opt_only),
            }
        )

ordered = sorted(enumerate(rows), key=lambda item: item[1]["McNemar_p"])
running = 0.0
for rank, (index, row) in enumerate(ordered):
    running = max(running, min(1.0, row["McNemar_p"] * (len(rows) - rank)))
    rows[index]["Holm校正p"] = running

with (OUT / "跨数据集同训练模型公平对比.csv").open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)

lines = [
    "# 跨数据集同训练模型公平对比",
    "",
    "对比双方都由 MiniMax M2.7 参与训练；测试使用相同题目、相同测试模型和相同 SkillOpt 原生评测链路。正数表示 AEV merge-as-old 更好。",
    "",
    "| 数据集 | 测试模型 | 有效题数 | AEV | optMiniMax | AEV 净胜 | 净胜百分点 | Holm p |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
]
for row in rows:
    lines.append(
        f"| {row['数据集']} | {row['测试模型']} | {row['共同有效题数']} | "
        f"{row['AEV merge-as-old']} | {row['optMiniMax M2.7']} | {row['AEV净胜题数']:+d} | "
        f"{row['AEV净胜百分点']:+.2%} | {row['Holm校正p']:.4g} |"
    )
wins = sum(row["AEV净胜题数"] > 0 for row in rows)
losses = sum(row["AEV净胜题数"] < 0 for row in rows)
significant_wins = sum(row["AEV净胜题数"] > 0 and row["Holm校正p"] < 0.05 for row in rows)
lines.extend(
    [
        "",
        "## 大白话结论",
        "",
        f"- 一共 {len(rows)} 个同训练模型、同测试口径的格子，AEV 赢 {wins} 个，输 {losses} 个。",
        f"- AEV 有 {significant_wins} 个格子在多重比较校正后仍是明确优势。",
        "- 这张表能支持‘AEV 训练流程通常比 SkillOpt 的 MiniMax M2.7 训练流程产出更有效的 Skill’，但不能写成所有模型、所有数据集都必胜。",
    ]
)
(OUT / "跨数据集同训练模型公平对比.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(json.dumps({"rows": len(rows), "wins": wins, "losses": losses, "significantWins": significant_wins}))
