"""Run the AEV merge-as-lite adapter without modifying SkillOpt-Lite source."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


FILE_START = '<!-- AEV_SKILL_FILE_START "CORE.md" -->'
FILE_END = "<!-- AEV_SKILL_FILE_END -->"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def package_skill(markdown: str) -> str:
    return f"{FILE_START}\n{markdown.strip()}\n{FILE_END}"


def extract_skill(response: str) -> str:
    match = re.search(r"<skill>\s*(.*?)\s*</skill>", response, flags=re.DOTALL | re.IGNORECASE)
    if not match or not match.group(1).strip():
        raise RuntimeError("Lite editor returned no complete <skill> candidate")
    return match.group(1).strip() + "\n"


def score(eval_root: Path, metric: str, expected_ids: set[str]) -> tuple[float, dict[str, Any]]:
    summary = read_json(eval_root / "eval_summary.json")
    count = summary.get("n_items", summary.get("n"))
    if count is None:
        raise RuntimeError(f"Validation summary has no item count: {eval_root}")
    if int(count) != len(expected_ids):
        raise RuntimeError(f"Validation summary is incomplete: {count}/{len(expected_ids)} at {eval_root}")
    rows = [json.loads(line) for line in (eval_root / "results.jsonl").read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    observed = [str(row.get("id") or "") for row in rows]
    if len(observed) != len(expected_ids) or set(observed) != expected_ids:
        raise RuntimeError(f"Validation ledger has missing, duplicate or unexpected UIDs: {eval_root}")
    value = float(summary[metric])
    return value, {"hard": float(summary["hard"]), "soft": float(summary["soft"]), "n": int(count)}


def verify_officeqa_split(
    split_dir: Path, source_skills: list[dict[str, Any]], data_root: Path | None = None
) -> dict[str, Any]:
    ids: dict[str, set[str]] = {}
    for split in ("train", "val", "test"):
        path = split_dir / split / "items.json"
        if not path.is_file():
            raise RuntimeError(f"OfficeQA split is missing {path}")
        rows = read_json_array(path)
        if not rows:
            raise RuntimeError(f"OfficeQA {split} split is empty: {path}")
        split_ids: set[str] = set()
        for row in rows:
            uid = str(row.get("uid") or row.get("id") or "").strip()
            if not uid or uid in split_ids:
                raise RuntimeError(f"OfficeQA {split} has an empty or duplicate UID: {uid}")
            if not str(row.get("question") or "").strip() or not str(
                row.get("ground_truth") or row.get("answer") or ""
            ).strip():
                raise RuntimeError(f"OfficeQA {split} {uid} lacks question or answer; id-only splits are invalid")
            if data_root is not None:
                raw_sources = row.get("source_files")
                sources = raw_sources if isinstance(raw_sources, list) else str(raw_sources or "").splitlines()
                if not sources or any(not str(source).strip() for source in sources):
                    raise RuntimeError(f"OfficeQA {split} {uid} has no source files")
                for source in sources:
                    name = str(source).strip()
                    if Path(name).name != name or not (data_root / name).is_file():
                        raise RuntimeError(f"OfficeQA {split} {uid} is missing source document: {name}")
            split_ids.add(uid)
        ids[split] = split_ids
    if ids["train"] & ids["val"] or ids["train"] & ids["test"] or ids["val"] & ids["test"]:
        raise RuntimeError("OfficeQA train/val/test UID sets overlap")
    source_ids = {str(item.get("id") or "").strip() for item in source_skills}
    if len(source_ids) != len(source_skills) or not source_ids <= ids["train"]:
        raise RuntimeError("Verified source Skills must be unique members of the train split")
    return {split: len(split_ids) for split, split_ids in ids.items()}


def read_json_array(path: Path) -> list[dict[str, Any]]:
    rows = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise RuntimeError(f"Expected an array of OfficeQA rows in {path}")
    return rows


def run_logged(command: list[str], log_path: Path, env: dict[str, str], cwd: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as handle:
        handle.write("COMMAND:\n" + subprocess.list2cmdline(command) + "\n\n")
        completed = subprocess.run(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError(f"Lite validation failed ({completed.returncode}); see {log_path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    args = parser.parse_args()

    request = read_json(args.request.resolve())
    result_path = args.result.resolve()
    run_root = result_path.parent
    lite = request["lite"]
    source_skills = request["sourceSkills"]
    project_root = Path(lite["projectRoot"]).resolve()
    runtime_root = Path(lite["runtimeRoot"]).resolve()
    split_dir = Path(lite["splitDir"]).resolve()
    data_root = Path(lite["dataRoot"]).resolve()
    auth_file = Path(lite["authFile"]).resolve()
    environment = str(lite["environment"])
    rounds = int(lite["rounds"])
    workers = int(lite["workers"])
    model = str(lite["optimizerModel"])
    provider_id = str(lite["providerID"])
    max_bytes = int(lite["maxSkillBytes"])
    length_repair_attempts = int(lite.get("lengthRepairAttempts", 5))
    gate_metric = str(lite["gateMetric"])

    state_root = run_root / "lite-adapter"
    workspace = state_root / "workspace"
    history = state_root / "history"
    logs = state_root / "logs"
    eval_root = state_root / "eval"
    for folder in (workspace, history, logs, eval_root):
        folder.mkdir(parents=True, exist_ok=True)

    initial_path = project_root / "skillopt" / "envs" / environment / "skills" / "initial.md"
    config_path = runtime_root / "configs" / environment / "default.yaml"
    runner_path = runtime_root / "tools" / "lite_minimax_runner.py"
    helper_root = runtime_root / "tools"
    for label, target in (
        ("official initial skill", initial_path),
        ("runtime config", config_path),
        ("runtime evaluator", runner_path),
        ("split directory", split_dir),
        ("data root", data_root),
        ("auth file", auth_file),
    ):
        if not target.exists():
            raise RuntimeError(f"Missing {label}: {target}")

    split_counts = verify_officeqa_split(split_dir, source_skills, data_root) if environment == "officeqa" else None
    if split_counts:
        write_json(state_root / "split-preflight.json", split_counts)
    val_rows = read_json_array(split_dir / "val" / "items.json") if environment == "officeqa" else None
    expected_val_ids = {str(row.get("uid") or row.get("id")) for row in val_rows} if val_rows else None

    sys.path.insert(0, str(project_root))
    from skillopt.evaluation.gate import evaluate_gate  # type: ignore

    sys.path.insert(0, str(helper_root))
    from lite_minimax_runner import install_minimax_bridge  # type: ignore

    skill_path = workspace / "skill.md"
    state_path = state_root / "state.json"
    input_hash = hashlib.sha256(args.request.read_bytes()).hexdigest()
    split_hashes = {
        split: sha256(split_dir / split / "items.json")
        for split in ("train", "val", "test")
    } if environment == "officeqa" else {}
    state = read_json(state_path) if state_path.exists() else None
    if state and (state.get("inputHash") != input_hash or state.get("splitHashes") != split_hashes):
        raise RuntimeError("Lite merge resume inputs changed; refusing to mix two experiments")
    if state and state.get("status") == "completed":
        raise RuntimeError("Lite merge run already completed; refusing to repeat paid validation")
    best_path = history / "best.md"
    if state:
        accepted_round = int(state["bestRound"])
        accepted_path = initial_path if accepted_round == 0 else history / f"round{accepted_round}-candidate.md"
        if not accepted_path.is_file():
            raise RuntimeError("Lite merge state points to a missing accepted Skill snapshot")
        # State and immutable round snapshots are the recovery authority.
        shutil.copy2(accepted_path, skill_path)
        shutil.copy2(accepted_path, best_path)
    else:
        shutil.copy2(initial_path, skill_path)
    env = os.environ.copy()
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    if environment == "officeqa":
        env["OFFICEQA_DOCS_DIR"] = str(data_root)

    def evaluate(label: str) -> tuple[float, dict[str, Any]]:
        output = eval_root / label
        if (output / "eval_summary.json").is_file():
            if expected_val_ids is None:
                summary = read_json(output / "eval_summary.json")
                return float(summary[gate_metric]), {"hard": float(summary["hard"]), "soft": float(summary["soft"]), "n": int(summary["n_items"])}
            return score(output, gate_metric, expected_val_ids)
        command = [
            sys.executable,
            str(runner_path),
            "--auth-file",
            str(auth_file),
            "--provider-id",
            provider_id,
            "--model",
            model,
            "eval",
            "--config",
            str(config_path),
            "--skill",
            str(skill_path),
            "--split",
            "val",
            "--target_model",
            model,
            "--split_dir",
            str(split_dir),
            "--test_env_num",
            "0",
            "--workers",
            str(workers),
            "--max_api_workers",
            str(workers),
            "--out_root",
            str(output),
        ]
        if environment == "officeqa":
            command.extend(["--cfg-options", "env.search_mode=offline"])
        else:
            command.extend(["--data_root", str(data_root), "--mode", "multi"])
        run_logged(command, logs / f"{label}.log", env, runtime_root)
        if expected_val_ids is None:
            summary = read_json(output / "eval_summary.json")
            return float(summary[gate_metric]), {"hard": float(summary["hard"]), "soft": float(summary["soft"]), "n": int(summary["n_items"])}
        return score(output, gate_metric, expected_val_ids)

    if state:
        baseline_score = float(state["baselineScore"])
        baseline_detail = state["baselineDetail"]
        current_score = float(state["currentScore"])
        best_score = float(state["bestScore"])
        best_round = int(state["bestRound"])
        gate_ledger = list(state["gateLedger"])
        usage_rows = list(state["usageRows"])
    else:
        baseline_score, baseline_detail = evaluate("round0-baseline-val")
        current_score = baseline_score
        best_score = baseline_score
        best_round = 0
        shutil.copy2(skill_path, best_path)
        gate_ledger: list[dict[str, Any]] = []
        usage_rows: list[dict[str, Any]] = []
        state = {
            "schema": "auto-evolve/skillopt-lite-merge-state/v1",
            "status": "running", "inputHash": input_hash, "splitHashes": split_hashes,
            "baselineScore": baseline_score, "baselineDetail": baseline_detail,
            "currentScore": current_score, "bestScore": best_score, "bestRound": best_round,
            "gateLedger": gate_ledger, "usageRows": usage_rows,
        }
        write_json(state_path, state)
    bridge = install_minimax_bridge(auth_file, provider_id, model)

    # 每份源 Skill 只进入一个批次，避免重复证据伪造提升。
    chunk_size = max(1, math.ceil(len(source_skills) / rounds))
    batches = [source_skills[index : index + chunk_size] for index in range(0, len(source_skills), chunk_size)]
    for round_id, batch in enumerate(batches, start=1):
        if any(row.get("round") == round_id for row in gate_ledger):
            continue
        before = skill_path.read_text(encoding="utf-8-sig")
        evidence = "\n\n".join(
            f"===== VERIFIED SOURCE SKILL {item['id']} =====\n{item['packageText']}" for item in batch
        )
        limit_instruction = (
            f"The complete candidate must be at most {max_bytes} UTF-8 bytes."
            if max_bytes > 0
            else "Keep the candidate concise and deduplicated."
        )
        system = "You are the editor inside an adapted SkillOpt-Lite validation-gated merge loop."
        user = f"""Merge reusable knowledge from the independently verified source Skills into the current Skill.
Do not copy task identifiers, final answers, or case-specific constants. Preserve existing useful rules unless the
new verified evidence justifies a general improvement. {limit_instruction}
Return the COMPLETE revised Markdown only between <skill> and </skill>.

CURRENT SKILL:
<skill>
{before}
</skill>

VERIFIED SOURCE SKILLS FOR THIS ROUND:
{evidence}
"""
        candidate_path = history / f"round{round_id}-candidate.md"
        candidate = candidate_path.read_text(encoding="utf-8-sig") if candidate_path.is_file() else ""
        candidate_bytes = 0
        attempt_prompt = user
        if candidate:
            candidate_bytes = len(candidate.encode("utf-8"))
        else:
            for repair_attempt in range(length_repair_attempts + 1):
                response, usage = bridge.chat_optimizer(
                    system=system,
                    user=attempt_prompt,
                    max_completion_tokens=8192,
                    retries=2,
                    stage=f"merge_as_lite_round_{round_id}_attempt_{repair_attempt}",
                    timeout=600,
                )
                usage_rows.append({"round": round_id, "repairAttempt": repair_attempt, "usage": usage})
                candidate = extract_skill(response)
                candidate_bytes = len(candidate.encode("utf-8"))
                if max_bytes <= 0 or candidate_bytes <= max_bytes:
                    break
                attempt_prompt = f"""Your previous complete candidate was {candidate_bytes} UTF-8 bytes and exceeded the hard limit of {max_bytes} bytes.
Rewrite the COMPLETE Skill again. Preserve the most broadly reusable rules, deduplicate aggressively, and do not truncate.
Return only one complete candidate between <skill> and </skill>.

OVERSIZED CANDIDATE:
<skill>
{candidate}
</skill>
"""
        candidate_path.write_text(candidate, encoding="utf-8")
        if max_bytes > 0 and candidate_bytes > max_bytes:
            gate_ledger.append(
                {
                    "round": round_id,
                    "sourceIDs": [item["id"] for item in batch],
                    "action": "reject_length",
                    "candidateBytes": candidate_bytes,
                    "currentScore": current_score,
                }
            )
            state.update({"gateLedger": gate_ledger, "usageRows": usage_rows})
            write_json(state_path, state)
            continue

        skill_path.write_text(candidate, encoding="utf-8")
        candidate_score, candidate_detail = evaluate(f"round{round_id}-candidate-val")
        # 直接使用 Lite 的门禁判定，不在适配层另写接纳规则。
        gate = evaluate_gate(
            candidate,
            candidate_detail["hard"],
            before,
            current_score,
            best_path.read_text(encoding="utf-8-sig"),
            best_score,
            best_round,
            round_id,
            cand_soft=candidate_detail["soft"],
            metric=gate_metric,
        )
        accepted = gate.action != "reject"
        action = gate.action
        if accepted:
            current_score = gate.current_score
            if gate.action == "accept_new_best":
                best_score = gate.best_score
                best_round = gate.best_step
                shutil.copy2(skill_path, best_path)
        else:
            skill_path.write_text(before, encoding="utf-8")
        gate_ledger.append(
            {
                "round": round_id,
                "sourceIDs": [item["id"] for item in batch],
                "action": action,
                "candidateScore": candidate_score,
                "candidateDetail": candidate_detail,
                "currentScore": current_score,
                "bestScore": best_score,
                "candidateBytes": candidate_bytes,
            }
        )
        state.update({
            "currentScore": current_score, "bestScore": best_score, "bestRound": best_round,
            "gateLedger": gate_ledger, "usageRows": usage_rows,
        })
        write_json(state_path, state)

    shutil.copy2(best_path, skill_path)
    merged = package_skill(skill_path.read_text(encoding="utf-8-sig"))
    write_json(
        result_path,
        {
            "schema": "auto-evolve/skillopt-lite-merge-result/v1",
            "passed": True,
            "mergedSkill": merged,
            "baselineScore": baseline_score,
            "baselineDetail": baseline_detail,
            "bestScore": best_score,
            "bestRound": best_round,
            "gateLedger": gate_ledger,
            "tokenSummary": {"calls": usage_rows},
        },
    )
    state.update({"status": "completed", "resultPath": str(result_path), "bestRound": best_round, "bestScore": best_score})
    write_json(state_path, state)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        parsed = argparse.ArgumentParser(add_help=False)
        parsed.add_argument("--request")
        parsed.add_argument("--result")
        known, _ = parsed.parse_known_args()
        if known.result:
            write_json(
                Path(known.result).resolve(),
                {
                    "schema": "auto-evolve/skillopt-lite-merge-result/v1",
                    "passed": False,
                    "error": str(exc),
                },
            )
        raise
