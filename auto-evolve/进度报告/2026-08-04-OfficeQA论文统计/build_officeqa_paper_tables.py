import csv
import json
import math
import random
from pathlib import Path

ROOT = Path(r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest")
SKILLOPT = Path(r"C:\Users\ZhuanZ\Desktop\SkillOpt")
OUT = ROOT / "auto-evolve/进度报告/2026-08-04-OfficeQA论文统计"
OUT.mkdir(parents=True, exist_ok=True)

RUNS = {
    "GPT-5.4-mini": {
        "无 Skill": SKILLOPT / "outputs/officeqa-gpt54mini-skillopt-singleturn-noskill-20260716/results.jsonl",
        "AEV merge-as-old": SKILLOPT / "outputs/officeqa-gpt54mini-skillopt-singleturn-with-aev-skill-merged172-20260716/results.jsonl",
        "optMiniMax M2.7 Skill": SKILLOPT / "outputs/officeqa-gpt54mini-skillopt-singleturn-with-minimax27-trained-skill-20260719/results.jsonl",
        "AEV merge-as-opt": SKILLOPT / "outputs/officeqa-gpt54mini-skillopt-singleturn-with-merge-as-opt-minimax27-skill-20260730-recovery4/results.jsonl",
        "SkillOpt 官方 Skill": SKILLOPT / "outputs/officeqa-gpt54mini-skillopt-singleturn-with-original-skill-20260716/results.jsonl",
    },
    "GPT-5.4": {
        "无 Skill": SKILLOPT / "outputs/officeqa-gpt54-skillopt-native-singleturn-noskill-clean-20260718/results.jsonl",
        "AEV merge-as-old": SKILLOPT / "outputs/officeqa-gpt54-skillopt-singleturn-with-final-skill-20260716-011950/results.jsonl",
        "optMiniMax M2.7 Skill": SKILLOPT / "outputs/officeqa-gpt54-skillopt-singleturn-with-minimax27-trained-skill-20260719/results.jsonl",
        "AEV merge-as-opt": SKILLOPT / "outputs/officeqa-gpt54-skillopt-singleturn-with-merge-as-opt-minimax27-skill-20260726-v3/results.jsonl",
        "SkillOpt 官方 Skill": SKILLOPT / "outputs/officeqa-gpt54-skillopt-native-singleturn-official-skill-clean-20260718/results.jsonl",
    },
    "GPT-5.5": {
        "无 Skill": SKILLOPT / "outputs/officeqa-gpt55-skillopt-singleturn-noskill-20260714-145800/results.jsonl",
        "AEV merge-as-old": OUT / "uid0068-retry/composite-results.jsonl",
        "optMiniMax M2.7 Skill": SKILLOPT / "outputs/officeqa-gpt55-skillopt-singleturn-with-optminimax27-skill-20260719/results.jsonl",
        "AEV merge-as-opt": SKILLOPT / "outputs/officeqa-gpt55-skillopt-singleturn-with-merge-as-opt-minimax27-skill-20260730-recovery4/results.jsonl",
        "SkillOpt 官方 Skill": SKILLOPT / "outputs/officeqa-gpt55-skillopt-singleturn-with-official-skill-20260716/results.jsonl",
    },
    "MiniMax M2.7": {
        "无 Skill": SKILLOPT / "outputs/officeqa-minimax27-native-singleturn-no-skill-20260731/results.jsonl",
        "AEV merge-as-old": SKILLOPT / "outputs/officeqa-minimax27-skillopt-singleturn-with-aev-merge-as-old-skill-20260730-recovery4/results.jsonl",
        "optMiniMax M2.7 Skill": SKILLOPT / "outputs/officeqa-minimax27-native-singleturn-optminimax-skill-20260731/results.jsonl",
        "AEV merge-as-opt": SKILLOPT / "outputs/officeqa-minimax27-skillopt-singleturn-with-aev-merge-as-opt-skill-20260730-recovery4/results.jsonl",
    },
}

MATRIX_CONDITIONS = [
    "无 Skill",
    "AEV merge-as-old",
    "optMiniMax M2.7 Skill",
    "AEV merge-as-opt",
    "SkillOpt 官方 Skill",
]

ABLATION = {
    "无回撤": ROOT / "auto-evolve/runtime-state/ablation-runs/20260801-officeqa40-merge-ablation/final-eval-gpt54/no-replay/native-run/results.jsonl",
    "merge-as-old": ROOT / "auto-evolve/runtime-state/ablation-runs/20260801-officeqa40-merge-ablation/final-eval-gpt54/merge-as-old/native-run/results.jsonl",
    "merge-as-opt": SKILLOPT / "outputs/officeqa-gpt54-skillopt-singleturn-with-merge-as-opt-minimax27-skill-20260726-v3/results.jsonl",
}

EXCLUDED_RUNS = [
    ("GPT-5.4 merge-as-opt", "20260726", "0/172", "provider/backend 配置错误，已由 v3 替代"),
    ("GPT-5.4 merge-as-opt", "20260726-v2", "0/172", "provider/backend 配置错误，已由 v3 替代"),
    ("GPT-5.4-mini merge-as-opt", "20260730 初始", "23/172", "服务异常恢复前结果，已由 recovery4 替代"),
    ("GPT-5.5 merge-as-opt", "20260730 初始", "40/172", "服务异常恢复前结果，已由 recovery4 替代"),
    ("MiniMax M2.7 merge-as-old", "20260730 初始", "0/172", "provider 失败，已由 recovery4 替代"),
    ("MiniMax M2.7 merge-as-opt", "20260730 初始", "0/172", "provider 失败，已由 recovery4 替代"),
    ("MiniMax M2.7 无 Skill", "20260731 HTTP402 archive", "0/172", "额度/认证基础设施失败，已干净补跑"),
]

def read_jsonl(path):
    rows = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    by_id = {row["id"]: row for row in rows}
    if len(rows) != 172 or len(by_id) != 172:
        raise ValueError(f"{path}: expected 172 unique rows, got {len(rows)} rows/{len(by_id)} ids")
    return by_id

def hard(row):
    return 1 if float(row.get("hard", 0)) >= 1 else 0

def infra(row):
    if row.get("agent_ok"):
        return False
    reason = str(row.get("fail_reason", "")).lower()
    response = str(row.get("response", "")).strip()
    tokens = ["http 401", "http 402", "http 403", "http 408", "http 429", "timeout", "timed out", "connection", "provider", "authentication", "unauthorized", "rate limit", "empty response", "api error"]
    return not response or any(token in reason for token in tokens)

def wilson(k, n, z=1.959963984540054):
    p = k / n
    den = 1 + z * z / n
    center = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return center - half, center + half

def exact_mcnemar(improved, regressed):
    n = improved + regressed
    if n == 0:
        return 1.0
    low = min(improved, regressed)
    tail = sum(math.comb(n, i) for i in range(low + 1)) / (2 ** n)
    return min(1.0, 2 * tail)

def bootstrap_delta(base, comp, seed, reps=20000):
    ids = sorted(base)
    diffs = [hard(comp[i]) - hard(base[i]) for i in ids]
    rng = random.Random(seed)
    samples = []
    n = len(diffs)
    for _ in range(reps):
        samples.append(sum(diffs[rng.randrange(n)] for _ in range(n)) / n)
    samples.sort()
    return samples[int(0.025 * reps)], samples[int(0.975 * reps)]

def holm_adjust(rows):
    order = sorted(range(len(rows)), key=lambda i: rows[i]["p_raw"])
    running = 0.0
    m = len(rows)
    for rank, idx in enumerate(order):
        adjusted = min(1.0, rows[idx]["p_raw"] * (m - rank))
        running = max(running, adjusted)
        rows[idx]["p_holm"] = running

def pct(value):
    return f"{value * 100:.2f}%"

loaded = {model: {condition: read_jsonl(path) for condition, path in conditions.items()} for model, conditions in RUNS.items()}
canonical_ids = set(next(iter(next(iter(loaded.values())).values())))
for model, conditions in loaded.items():
    for condition, rows in conditions.items():
        if set(rows) != canonical_ids:
            raise ValueError(f"UID mismatch: {model}/{condition}")

matrix_rows = []
accepted_audit = []
for model, conditions in loaded.items():
    for condition, rows in conditions.items():
        infra_count = sum(infra(row) for row in rows.values())
        valid_rows = [row for row in rows.values() if not infra(row)]
        n_valid = len(valid_rows)
        k = sum(hard(row) for row in valid_rows)
        soft = sum(float(row.get("soft", 0)) for row in valid_rows) / n_valid
        lo, hi = wilson(k, n_valid)
        matrix_rows.append({"model": model, "condition": condition, "correct": k, "n": n_valid, "n_raw": 172, "accuracy": k / n_valid, "ci_low": lo, "ci_high": hi, "soft": soft, "infra": infra_count, "source": str(RUNS[model][condition])})
        accepted_audit.append({"decision": "纳入" if infra_count == 0 else "条件纳入", "experiment": f"{model} / {condition}", "rows": 172, "unique_ids": 172, "infra": infra_count, "reason": "完整同口径结果" if infra_count == 0 else "1 条基础设施失败从有效分母和配对检验中排除，建议后续只补跑该 UID", "source": str(RUNS[model][condition])})

pair_rows = []
seed = 20260804
for model, conditions in loaded.items():
    base = conditions["无 Skill"]
    for condition in (name for name in MATRIX_CONDITIONS if name != "无 Skill" and name in conditions):
        comp = conditions[condition]
        both_correct = both_wrong = improved = regressed = 0
        paired_ids = [uid for uid in sorted(canonical_ids) if not infra(base[uid]) and not infra(comp[uid])]
        for uid in paired_ids:
            b, c = hard(base[uid]), hard(comp[uid])
            if b == 1 and c == 1: both_correct += 1
            elif b == 0 and c == 0: both_wrong += 1
            elif b == 0 and c == 1: improved += 1
            else: regressed += 1
        filtered_base = {uid: base[uid] for uid in paired_ids}
        filtered_comp = {uid: comp[uid] for uid in paired_ids}
        ci_low, ci_high = bootstrap_delta(filtered_base, filtered_comp, seed + len(pair_rows))
        pair_rows.append({
            "model": model, "comparison": f"{condition} vs 无 Skill", "paired_n": len(paired_ids), "both_correct": both_correct,
            "improved": improved, "regressed": regressed, "both_wrong": both_wrong,
            "net_cases": improved - regressed, "delta": (improved - regressed) / len(paired_ids),
            "delta_ci_low": ci_low, "delta_ci_high": ci_high,
            "p_raw": exact_mcnemar(improved, regressed),
        })
holm_adjust(pair_rows)

case_rows = []
for model, conditions in loaded.items():
    for uid in sorted(canonical_ids):
        vals = {condition: (None if infra(rows[uid]) else hard(rows[uid])) for condition, rows in conditions.items()}
        def difference(left, right):
            return "" if left is None or right is None else left - right
        case_rows.append({
            "model": model, "uid": uid, **vals,
            "old_vs_none": difference(vals["AEV merge-as-old"], vals["无 Skill"]),
            "optmini_vs_none": difference(vals["optMiniMax M2.7 Skill"], vals["无 Skill"]),
            "mergeopt_vs_none": difference(vals["AEV merge-as-opt"], vals["无 Skill"]),
            "official_vs_none": difference(vals.get("SkillOpt 官方 Skill"), vals["无 Skill"]),
        })

ablation_loaded = {name: read_jsonl(path) for name, path in ABLATION.items()}
ablation_rows = []
baseline = ablation_loaded["无回撤"]
for name, rows in ablation_loaded.items():
    k = sum(hard(row) for row in rows.values())
    soft = sum(float(row.get("soft", 0)) for row in rows.values()) / 172
    lo, hi = wilson(k, 172)
    improved = sum(hard(rows[i]) > hard(baseline[i]) for i in canonical_ids)
    regressed = sum(hard(rows[i]) < hard(baseline[i]) for i in canonical_ids)
    ci_delta = (0.0, 0.0) if name == "无回撤" else bootstrap_delta(baseline, rows, seed + 100 + len(ablation_rows))
    ablation_rows.append({"strategy": name, "correct": k, "n": 172, "accuracy": k / 172, "ci_low": lo, "ci_high": hi, "soft": soft, "improved": improved, "regressed": regressed, "delta": (improved-regressed)/172, "delta_ci_low": ci_delta[0], "delta_ci_high": ci_delta[1], "mcnemar_p": 1.0 if name == "无回撤" else exact_mcnemar(improved, regressed), "source": str(ABLATION[name])})

ablation_pair_rows = []
for left, right in [("无回撤", "merge-as-old"), ("无回撤", "merge-as-opt"), ("merge-as-old", "merge-as-opt")]:
    a, b = ablation_loaded[left], ablation_loaded[right]
    improved = sum(hard(b[i]) > hard(a[i]) for i in canonical_ids)
    regressed = sum(hard(b[i]) < hard(a[i]) for i in canonical_ids)
    ci_low, ci_high = bootstrap_delta(a, b, seed + 300 + len(ablation_pair_rows))
    ablation_pair_rows.append({"comparison": f"{right} vs {left}", "paired_n": 172, "improved": improved, "regressed": regressed, "net_cases": improved-regressed, "delta": (improved-regressed)/172, "delta_ci_low": ci_low, "delta_ci_high": ci_high, "mcnemar_p": exact_mcnemar(improved, regressed)})

for experiment, run, observed, reason in EXCLUDED_RUNS:
    accepted_audit.append({"decision": "排除", "experiment": experiment, "rows": observed, "unique_ids": "未作为正式结果", "infra": "是", "reason": reason, "source": run})

def read_skillopt_summary(path):
    summary = json.loads(path.read_text(encoding="utf-8-sig"))
    usage = summary["token_summary"]["_total"]
    return int(usage["calls"]), int(usage["prompt_tokens"]), int(usage["completion_tokens"]), int(summary.get("total_accepts", 0)), int(summary.get("total_rejects", 0)), float(summary.get("total_wall_time_s", 0))

cost_rows = []
opt_history = SKILLOPT / "outputs/officeqa-minimax-m27-codingplan-fixed-official-20260629-195923/summary.json"
mergeopt_history = ROOT / "auto-evolve/runtime-state/benchmark-runs/20260722-230100-officeqa40-merge-as-opt-native-minimax27/merge-and-validate/phase2-skillopt/native-train-fixed-20260726/summary.json"
for label, path, scope in [
    ("optMiniMax M2.7 原生训练", opt_history, "4 epochs / 8 steps，训练与验证调用"),
    ("AEV merge-as-opt 合并优化", mergeopt_history, "40 个冻结 AEV Skills 的 SkillOpt 原生优化"),
]:
    calls, prompt, completion, accepts, rejects, wall = read_skillopt_summary(path)
    cost_rows.append({"stage": label, "scope": scope, "calls": calls, "prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt+completion, "wall_time_s": wall, "accepted_edits": accepts, "rejected_edits": rejects, "coverage": "完整 summary.token_summary（包含 baseline 与 slow update）", "source": str(path)})

aev_audit = OUT / "aev-retained-lineage-token-audit.json"
if aev_audit.exists():
    audit = json.loads(aev_audit.read_text(encoding="utf-8-sig"))
    t = audit["totals"]
    c = audit["coverage"]
    cost_rows.insert(0, {"stage": "AEV 单案例长程训练（最终保留血统）", "scope": "40 个最终保留 verified campaign；不含已删除事件与旧失败分支", "calls": t.get("steps", 0), "prompt_tokens": t.get("inputTokens", 0), "completion_tokens": t.get("outputTokens", 0), "reasoning_tokens": t.get("reasoningTokens", 0), "cache_read_tokens": t.get("cacheReadTokens", 0), "cache_write_tokens": t.get("cacheWriteTokens", 0), "total_tokens": t.get("totalTokens", 0), "wall_time_s": "不可由事件可靠还原", "accepted_edits": "不适用", "rejected_edits": "不适用", "coverage": f"eventFiles={c.get('eventFiles',0)}, unreadable={c.get('unreadableFiles',0)}；历史消耗下界", "source": str(aev_audit)})
else:
    cost_rows.insert(0, {"stage": "AEV 单案例长程训练（最终保留血统）", "scope": "40 个最终保留 verified campaign", "calls": "待审计", "prompt_tokens": "待审计", "completion_tokens": "待审计", "total_tokens": "待审计", "wall_time_s": "未知", "accepted_edits": "不适用", "rejected_edits": "不适用", "coverage": "等待历史 events.json 审计", "source": str(aev_audit)})
cost_rows.append({"stage": "无回撤 / merge-as-old 本次合并", "scope": "40 Skills 分层合并；merge-as-old 含 level1 replay 与一次 repair", "calls": "未知", "prompt_tokens": "未知", "completion_tokens": "未知", "total_tokens": "未知", "wall_time_s": "可从启动时间估计但未作为 token 成本", "accepted_edits": "不适用", "rejected_edits": "不适用", "coverage": "历史合并产物未保存 provider usage，不能记为 0", "source": str(ROOT / "auto-evolve/runtime-state/ablation-runs/20260801-officeqa40-merge-ablation")})

def write_csv(name, rows):
    path = OUT / name
    fields = []
    for row in rows:
        for key in row:
            if key not in fields: fields.append(key)
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader(); writer.writerows(rows)

write_csv("表1-总矩阵.csv", matrix_rows)
write_csv("表2-合并消融.csv", ablation_rows)
write_csv("表2b-合并消融配对显著性.csv", ablation_pair_rows)
write_csv("表3-逐题配对差异.csv", case_rows)
write_csv("表3b-配对显著性.csv", pair_rows)
write_csv("表4-基础设施审计.csv", accepted_audit)
write_csv("表5-训练成本.csv", cost_rows)

def md_table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows: lines.append("| " + " | ".join(str(x).replace("|", "\\|") for x in row) + " |")
    return "\n".join(lines)

matrix_md = []
for model in RUNS:
    row = [model]
    for condition in MATRIX_CONDITIONS:
        item = next((x for x in matrix_rows if x["model"] == model and x["condition"] == condition), None)
        if item is None:
            row.append("未测试")
            continue
        suffix = f"; infra={item['infra']}" if item["infra"] else ""
        row.append(f"{item['correct']}/{item['n']} = {pct(item['accuracy'])} [{pct(item['ci_low'])}, {pct(item['ci_high'])}]{suffix}")
    matrix_md.append(row)

ablation_md = [[r["strategy"], f"{r['correct']}/172", pct(r["accuracy"]), f"[{pct(r['ci_low'])}, {pct(r['ci_high'])}]", pct(r["soft"]), f"{r['improved']}/{r['regressed']}", pct(r["delta"]), f"[{pct(r['delta_ci_low'])}, {pct(r['delta_ci_high'])}]", f"{r['mcnemar_p']:.4g}"] for r in ablation_rows]
ablation_pair_md = [[r["comparison"], r["paired_n"], r["improved"], r["regressed"], f"{r['net_cases']:+d}", pct(r["delta"]), f"[{pct(r['delta_ci_low'])}, {pct(r['delta_ci_high'])}]", f"{r['mcnemar_p']:.4g}"] for r in ablation_pair_rows]
pair_md = [[r["model"], r["comparison"], r["paired_n"], r["both_correct"], r["improved"], r["regressed"], r["both_wrong"], f"{r['net_cases']:+d}", pct(r["delta"]), f"[{pct(r['delta_ci_low'])}, {pct(r['delta_ci_high'])}]", f"{r['p_raw']:.4g}", f"{r['p_holm']:.4g}"] for r in pair_rows]
audit_md = [[r["decision"], r["experiment"], r["rows"], r["unique_ids"], r["infra"], r["reason"]] for r in accepted_audit]
cost_md = [[r.get("stage",""), r.get("scope",""), r.get("calls",""), r.get("prompt_tokens",""), r.get("completion_tokens",""), r.get("reasoning_tokens",0), r.get("cache_read_tokens",0), r.get("cache_write_tokens",0), r.get("total_tokens",""), r.get("wall_time_s",""), r.get("coverage","")] for r in cost_rows]

report = f"""# OfficeQA 论文级实验统计表（2026-08-04）

## 统一口径

- 测试集：OfficeQA 官方 `valid_unseen`，172 个唯一 UID。
- 推理方式：SkillOpt 原生单轮、无工具、oracle-page context、medium reasoning。
- 正式运行原则：优先使用 172/172 且基础设施失败为 0 的结果；GPT-5.5/AEV merge-as-old 的 UID0068 已隔离补跑并确认是真实答错，正式统计恢复为 112/172。
- 准确率区间：95% Wilson score interval。
- 配对差异区间：20,000 次、固定种子 `20260804` 的 UID 级配对 bootstrap。
- 显著性：双侧 exact McNemar；主矩阵所有已有的“Skill vs 无 Skill”比较同时报告 Holm 校正 p 值。

## 表1：OfficeQA 总矩阵（Hard Accuracy，95% CI）

{md_table(['测试模型', *MATRIX_CONDITIONS], matrix_md)}

## 表2：合并策略消融（GPT-5.4）

{md_table(['策略','正确数','Hard','95% CI','Soft','改善/退化','净增益','配对增益95% CI','McNemar p'], ablation_md)}

### 表2配对比较

{md_table(['比较','配对N','改善','退化','净题数','净增益','配对增益95% CI','McNemar p'], ablation_pair_md)}

## 表3：逐题配对差异与显著性

下表汇总逐题配对；完整 688 行 UID 明细见 `表3-逐题配对差异.csv`。

{md_table(['测试模型','比较','配对N','共同正确','改善','退化','共同错误','净题数','净增益','配对增益95% CI','原始p','Holm p'], pair_md)}

## 表4：基础设施审计

{md_table(['处理','实验','行数','唯一UID','基础设施失败','原因'], audit_md)}

## 表5：训练成本与覆盖边界

{md_table(['阶段','统计范围','调用/步骤','输入Token','输出Token','推理Token','缓存读','缓存写','总Token','墙钟秒','覆盖说明'], cost_md)}

## 当前可写入论文的结论

- 相对无 Skill，`AEV merge-as-old` 与 `AEV merge-as-opt` 在 GPT-5.4-mini、GPT-5.4、GPT-5.5 上均为正增益，且 exact McNemar 经 Holm 校正后仍小于 0.05。
- `optMiniMax M2.7 Skill` 只在 GPT-5.4 上呈现经校正后的显著正增益；在 GPT-5.4-mini、GPT-5.5 和 MiniMax M2.7 上均未达到显著。
- MiniMax M2.7 作为测试模型时，三种 Skill 相对无 Skill 的配对区间全部跨 0，不能宣称有稳定提升。
- 合并消融中，merge-as-opt 比无回撤高 7 题、比 merge-as-old 高 6 题，但两项配对区间均跨 0，McNemar p 分别为 0.2962 和 0.4050；当前只能报告点估计更高，不能写成显著优势。
- AEV 最终保留血统可恢复 6.46 亿处理 Token，其中缓存读取 5.85 亿；该数字只覆盖 36/40 个可追溯 campaign，仍是历史实际总消耗的下界。

## 解释边界

- AEV 历史长程训练成本只报告仍可从 `events.json` 恢复的最终保留血统，是下界，不等于机器实际全部消耗。
- `merge-as-old` 本次合并没有保存 provider usage，因此成本标记未知，绝不能写成 0。
- 单次 172 题结果的 Wilson 区间描述准确率不确定性；方法间结论优先看逐题配对 bootstrap 与 McNemar，而不是只比较两个区间是否重叠。
"""
(OUT / "OfficeQA论文级五表.md").write_text(report, encoding="utf-8")

evidence = {"matrix": matrix_rows, "ablation": ablation_rows, "ablation_pairwise": ablation_pair_rows, "pairwise": pair_rows, "infrastructure_audit": accepted_audit, "cost": cost_rows}
(OUT / "OfficeQA论文级五表-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"out": str(OUT), "matrix_cells": len(matrix_rows), "paired_rows": len(pair_rows), "case_rows": len(case_rows), "audit_rows": len(accepted_audit), "cost_rows": len(cost_rows)}, ensure_ascii=False))
