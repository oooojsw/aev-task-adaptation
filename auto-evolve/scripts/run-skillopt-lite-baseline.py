"""Run a length-gated MiniMax SkillOpt-Lite baseline from the official initial Skill."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def run_logged(command: list[str], log: Path, env: dict[str, str], cwd: Path) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w", encoding="utf-8") as handle:
        handle.write("COMMAND:\n" + subprocess.list2cmdline(command) + "\n\n")
        completed = subprocess.run(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT)
    if completed.returncode:
        raise RuntimeError(f"Lite command failed ({completed.returncode}); see {log}")


def eval_score(root: Path, metric: str, expected_ids: set[str]) -> tuple[float, dict[str, Any]]:
    summary = read_json(root / "eval_summary.json")
    count = summary.get("n_items", summary.get("n"))
    if count is None:
        raise RuntimeError(f"Evaluation summary has no item count: {root}")
    if int(count) != len(expected_ids):
        raise RuntimeError(f"Incomplete evaluation summary at {root}: {count}/{len(expected_ids)}")
    rows = [json.loads(line) for line in (root / "results.jsonl").read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    observed = [str(row.get("id") or "") for row in rows]
    if len(observed) != len(expected_ids) or set(observed) != expected_ids:
        raise RuntimeError(f"Evaluation ledger has missing, duplicated or unexpected UIDs: {root}")
    detail = {"hard": float(summary["hard"]), "soft": float(summary["soft"]), "n": int(count)}
    return detail[metric], detail


def train_batch_score(root: Path, metric: str, train_ids: set[str], expected_count: int) -> tuple[float, dict[str, Any]]:
    summary = read_json(root / "eval_summary.json")
    rows = [json.loads(line) for line in (root / "results.jsonl").read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    observed = [str(row.get("id") or "") for row in rows]
    if int(summary.get("n_items", summary.get("n", -1))) != expected_count or len(observed) != expected_count or len(set(observed)) != expected_count or not set(observed) <= train_ids:
        raise RuntimeError(f"Incomplete or invalid train batch ledger: {root}")
    detail = {"hard": float(summary["hard"]), "soft": float(summary["soft"]), "n": expected_count}
    return detail[metric], detail


def read_split_ids(split_dir: Path, data_root: Path) -> dict[str, set[str]]:
    expected = {"train": 50, "val": 24, "test": 172}
    split_ids: dict[str, set[str]] = {}
    for split, count in expected.items():
        rows = read_json(split_dir / split / "items.json")
        if not isinstance(rows, list) or len(rows) != count:
            raise RuntimeError(f"OfficeQA {split} must contain exactly {count} complete rows")
        ids: set[str] = set()
        for row in rows:
            uid = str(row.get("uid") or row.get("id") or "").strip()
            if not uid or uid in ids or not str(row.get("question") or "").strip() or not str(row.get("ground_truth") or row.get("answer") or "").strip():
                raise RuntimeError(f"OfficeQA {split} has a missing/duplicate UID or empty question/answer: {uid}")
            raw_sources = row.get("source_files")
            sources = raw_sources if isinstance(raw_sources, list) else str(raw_sources or "").splitlines()
            if not sources or any(Path(str(source).strip()).name != str(source).strip() or not (data_root / str(source).strip()).is_file() for source in sources):
                raise RuntimeError(f"OfficeQA {split} {uid} has missing source material")
            ids.add(uid)
        split_ids[split] = ids
    if split_ids["train"] & split_ids["val"] or split_ids["train"] & split_ids["test"] or split_ids["val"] & split_ids["test"]:
        raise RuntimeError("OfficeQA train/val/test UID overlap")
    return split_ids


def compact_samples(samples: Path, limit: int = 40000) -> str:
    files = sorted((samples / "failed").glob("*.md")) + sorted((samples / "passed").glob("*.md"))
    selected: list[str] = []
    used = 0
    for item in files:
        text = item.read_text(encoding="utf-8", errors="replace")
        snippet = f"\n\n--- {item.name} ---\n{text[:6000]}"
        if used + len(snippet) > limit:
            break
        selected.append(snippet)
        used += len(snippet)
    return "".join(selected)


def extract_candidate(response: str) -> str:
    match = re.search(r"<skill>\s*(.*?)\s*</skill>", response, flags=re.DOTALL | re.IGNORECASE)
    if not match or not match.group(1).strip():
        raise RuntimeError("Lite editor returned no complete <skill> candidate")
    return match.group(1).strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--official-root", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--split-dir", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--auth-file", type=Path, required=True)
    parser.add_argument("--provider-id", default="minimax-cn-coding-plan")
    parser.add_argument("--model", default="MiniMax-M2.7")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--batch", type=int, default=40)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--max-skill-bytes", type=int, default=5768)
    parser.add_argument("--length-repair-attempts", type=int, default=5)
    parser.add_argument("--gate-metric", choices=("hard", "soft"), default="hard")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    official_root = args.official_root.resolve()
    runtime_root = args.runtime_root.resolve()
    out = args.out.resolve()
    split_dir = args.split_dir.resolve()
    data_root = args.data_root.resolve()
    auth_file = args.auth_file.resolve()
    initial = official_root / "skillopt" / "envs" / "officeqa" / "skills" / "initial.md"
    prompt = official_root / "copilot_example" / "officeqa" / ".github" / "prompts" / "skillopt-loop.prompt.md"
    config = runtime_root / "configs" / "officeqa" / "default.yaml"
    runner = runtime_root / "tools" / "lite_minimax_runner.py"
    make_samples = runtime_root / "copilot_example" / "make_samples.py"
    for label, target in (
        ("official initial Skill", initial), ("official Lite prompt", prompt),
        ("runtime config", config), ("runtime evaluator", runner),
        ("sample builder", make_samples), ("split directory", split_dir),
        ("data root", data_root), ("auth file", auth_file),
    ):
        if not target.exists():
            raise RuntimeError(f"Missing {label}: {target}")
    if args.rounds < 1 or args.batch < 1 or args.workers < 1 or args.max_skill_bytes < 1:
        raise RuntimeError("rounds, batch, workers and max-skill-bytes must be positive")
    split_ids = read_split_ids(split_dir, data_root)
    protocol = {
        "model": args.model,
        "providerID": args.provider_id,
        "rounds": args.rounds,
        "batch": args.batch,
        "workers": args.workers,
        "maxSkillBytes": args.max_skill_bytes,
        "gateMetric": args.gate_metric,
        "initialSha256": hashlib.sha256(initial.read_bytes()).hexdigest(),
        "splitSha256": {split: hashlib.sha256((split_dir / split / "items.json").read_bytes()).hexdigest() for split in split_ids},
        "dataRoot": str(data_root),
        "splitDir": str(split_dir),
    }
    protocol_hash = hashlib.sha256(json.dumps(protocol, sort_keys=True).encode("utf-8")).hexdigest()

    state_path = out / "state.json"
    if state_path.exists() and not args.resume:
        raise RuntimeError(f"Run already exists; use --resume instead of overwriting: {out}")
    if state_path.exists() and read_json(state_path).get("protocolHash") != protocol_hash:
        raise RuntimeError("Resume protocol changed; refusing to mix experiment conditions")
    if state_path.exists() and read_json(state_path).get("status") == "completed":
        raise RuntimeError("Baseline run is already complete; refusing to spend quota again")
    workspace = out / "workspace"
    history = workspace / ".skillopt" / "history"
    samples = workspace / ".skillopt" / "samples"
    logs = out / "logs"
    for folder in (history, samples / "failed", samples / "passed", logs):
        folder.mkdir(parents=True, exist_ok=True)
    skill = workspace / "skill.md"
    if not state_path.exists():
        shutil.copy2(initial, skill)
        if len(skill.read_bytes()) > args.max_skill_bytes:
            raise RuntimeError("Official initial Skill already exceeds the configured hard limit")
    elif (history / "best.md").is_file():
        # An interrupted candidate cannot become the active Skill on resume.
        shutil.copy2(history / "best.md", skill)

    sys.path.insert(0, str(runtime_root / "tools"))
    from lite_minimax_runner import install_minimax_bridge  # type: ignore

    env = os.environ.copy()
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "OFFICEQA_DOCS_DIR": str(data_root)})
    state: dict[str, Any] = read_json(state_path) if state_path.exists() else {
        "schema": "auto-evolve/skillopt-lite-length-gated-baseline/v1",
        "status": "running",
        "startedAt": now(),
        "model": args.model,
        "trainCount": 50,
        "validationCount": 24,
        "testCount": 172,
        "roundsRequested": args.rounds,
        "batch": args.batch,
        "workers": args.workers,
        "maxSkillBytes": args.max_skill_bytes,
        "gateMetric": args.gate_metric,
        "protocolHash": protocol_hash,
        "protocol": protocol,
        "rounds": [],
    }
    state.update({"status": "running", "resumedAt": now()} if state_path.exists() else {"status": "running"})
    write_json(state_path, state)

    def evaluate(label: str, split: str, limit: int) -> tuple[float, dict[str, Any], Path]:
        skill_hash = hashlib.sha256(skill.read_bytes()).hexdigest()[:12]
        eval_out = out / "eval" / f"{label}-{skill_hash}"
        if (eval_out / "eval_summary.json").exists():
            value, detail = (
                eval_score(eval_out, args.gate_metric, split_ids[split])
                if limit == 0 else train_batch_score(eval_out, args.gate_metric, split_ids[split], limit)
            )
            return value, detail, eval_out
        command = [
            sys.executable, str(runner), "--auth-file", str(auth_file), "--provider-id", args.provider_id,
            "--model", args.model, "eval", "--config", str(config), "--skill", str(skill),
            "--split", split, "--target_model", args.model, "--split_dir", str(split_dir),
            "--test_env_num", str(limit), "--workers", str(args.workers),
            "--max_api_workers", str(args.workers), "--out_root", str(eval_out),
            "--cfg-options", "env.search_mode=offline",
        ]
        run_logged(command, logs / f"{label}.log", env, runtime_root)
        value, detail = (
            eval_score(eval_out, args.gate_metric, split_ids[split])
            if limit == 0 else train_batch_score(eval_out, args.gate_metric, split_ids[split], limit)
        )
        return value, detail, eval_out

    def rebuild_samples(source_eval: Path, label: str) -> None:
        for folder in (samples / "failed", samples / "passed"):
            if folder.exists():
                shutil.rmtree(folder)
            folder.mkdir(parents=True)
        command = [
            sys.executable, str(make_samples), "--results", str(source_eval / "results.jsonl"),
            "--workspace", str(workspace), "--env", "officeqa", "--limit", str(args.batch),
        ]
        run_logged(command, logs / f"samples-{label}.log", env, runtime_root)

    try:
        if state.get("baselineValidation"):
            baseline_detail = state["baselineValidation"]
            baseline_score = float(baseline_detail[args.gate_metric])
        else:
            baseline_score, baseline_detail, _ = evaluate("round0-val", "val", 0)
        state.setdefault("baselineValidation", baseline_detail)
        write_json(state_path, state)
        best_score = float(state.get("bestScore", baseline_score))
        current_score = float(state.get("currentScore", baseline_score))
        best_round = int(state.get("bestRound", 0))
        best_skill = history / "best.md"
        if not best_skill.exists():
            shutil.copy2(skill, best_skill)
        completed_rounds = {int(item["round"]) for item in state["rounds"]}
        bridge = install_minimax_bridge(auth_file, args.provider_id, args.model)

        for round_id in range(1, args.rounds + 1):
            if round_id in completed_rounds:
                continue
            _, _, train_eval = evaluate(f"round{round_id}-train", "train", args.batch)
            rebuild_samples(train_eval, f"round{round_id}")
            before = skill.read_text(encoding="utf-8-sig")
            evidence = compact_samples(samples)
            if not evidence:
                raise RuntimeError(f"Round {round_id} produced no rollout evidence")
            user = f"""Improve this OfficeQA Skill from the rollout evidence. Add only reusable rules supported by evidence,
never copy task answers or identifiers, and keep the COMPLETE candidate within {args.max_skill_bytes} UTF-8 bytes.
Return the complete Markdown only between <skill> and </skill>.

CURRENT SKILL:
<skill>
{before}
</skill>

ROLLOUT EVIDENCE:
{evidence}
"""
            candidate = ""
            candidate_bytes = 0
            usage_rows: list[dict[str, Any]] = []
            for repair in range(args.length_repair_attempts + 1):
                response, usage = bridge.chat_optimizer(
                    system="You are the coding agent in the published SkillOpt-Lite closed loop.",
                    user=user,
                    max_completion_tokens=8192,
                    retries=2,
                    stage=f"lite_baseline_round_{round_id}_attempt_{repair}",
                    timeout=600,
                )
                usage_rows.append({"repairAttempt": repair, "usage": usage})
                candidate = extract_candidate(response)
                candidate_bytes = len(candidate.encode("utf-8"))
                if candidate_bytes <= args.max_skill_bytes:
                    break
                user = f"""The previous complete candidate was {candidate_bytes} UTF-8 bytes and exceeded the hard limit
of {args.max_skill_bytes} bytes. Rewrite it completely, deduplicate aggressively, do not truncate, and return only
the revised Markdown between <skill> and </skill>.

<skill>
{candidate}
</skill>
"""
            candidate_path = history / f"round{round_id}-candidate.md"
            candidate_path.write_text(candidate, encoding="utf-8")
            if candidate_bytes > args.max_skill_bytes:
                action = "reject_length"
                candidate_score = None
                candidate_detail = None
            else:
                skill.write_text(candidate, encoding="utf-8")
                candidate_score, candidate_detail, _ = evaluate(f"round{round_id}-candidate-val", "val", 0)
                # 官方 Lite gate 只接纳严格提升，同分必须回滚。
                if candidate_score > current_score:
                    action = "accept_new_best" if candidate_score > best_score else "accept"
                    current_score = candidate_score
                    if candidate_score > best_score:
                        best_score = candidate_score
                        best_round = round_id
                        shutil.copy2(skill, best_skill)
                else:
                    action = "reject"
                    skill.write_text(before, encoding="utf-8")
            state["rounds"].append({
                "round": round_id,
                "action": action,
                "candidateBytes": candidate_bytes,
                "candidateScore": candidate_score,
                "candidateValidation": candidate_detail,
                "currentScore": current_score,
                "bestScore": best_score,
                "usage": usage_rows,
                "finishedAt": now(),
            })
            state.update({"currentScore": current_score, "bestScore": best_score, "bestRound": best_round})
            write_json(state_path, state)

        shutil.copy2(best_skill, skill)
        _, final_detail, _ = evaluate("final-test", "test", 0)
        state.update({
            "status": "completed",
            "completedAt": now(),
            "bestScore": best_score,
            "bestRound": best_round,
            "finalSkillBytes": len(skill.read_bytes()),
            "finalTest": final_detail,
        })
        write_json(state_path, state)
        print(json.dumps({"ok": True, "out": str(out), "finalTest": final_detail}, ensure_ascii=False))
        return 0
    except Exception as exc:
        state.update({"status": "failed", "failedAt": now(), "error": str(exc)})
        write_json(state_path, state)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
