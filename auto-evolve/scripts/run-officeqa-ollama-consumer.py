"""Evaluate frozen OfficeQA prompts with local Ollama without changing SkillOpt."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


SKILLOPT_ROOT = Path("C:/Users/ZhuanZ/Desktop/SkillOpt")
OFFICIAL_SKILL = SKILLOPT_ROOT / "ckpt/officeqa/gpt5.5_skill.md"
OUTPUT_ROOT = Path("E:/project/SkillOpt-length-cap-runs/officeqa-ollama-local-direct-answer-t07-20260925")
SOURCE_FILES = {
    "no-skill": Path("E:/project/SkillOpt-length-cap-runs/officeqa-clean42-native-noskill-minimax27-20260923/native-output/results.jsonl"),
    "native-opt-a": Path("E:/project/SkillOpt-length-cap-runs/officeqa-fair-a-nativeopt-length5768-minimax27-20260922/test-valid-unseen-172/native-output/results.jsonl"),
    "aev-native-d": Path("E:/project/SkillOpt-length-cap-runs/officeqa-clean42-merge-as-old-length5768-minimax27-20260923/test-valid-unseen-172/native-output/results.jsonl"),
    "official-gpt55": SKILLOPT_ROOT / "outputs/officeqa-minimax27-skillopt-native-singleturn-with-official-gpt55-skill-20260902/results.jsonl",
}
MODELS = ("llama3.2:3b", "qwen3:8b")
CONDITIONS = tuple(SOURCE_FILES)
ORIGINAL_CONDITIONS = ("no-skill", "native-opt-a", "aev-native-d")
API_ROOT = "http://127.0.0.1:11434"
NUM_CTX = 32768
NUM_PREDICT = 1024
TEMPERATURE = 0.7
SEED = 42
SMOKE_UID = "UID0003"
USER_SUFFIX = (
    "\n\nAnswer the question now. Use only the supplied document text. "
    "Respond in one line exactly as <answer>value</answer>; do not provide steps or explanation."
)
_ANSWER = re.compile(r"<answer>(.*?)</answer>", re.IGNORECASE | re.DOTALL)
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

sys.path.insert(0, str(SKILLOPT_ROOT))
from skillopt.envs.officeqa.evaluator import evaluate  # noqa: E402


def request_json(endpoint: str, payload: dict | None = None, timeout: int = 30) -> dict:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        API_ROOT + endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with _OPENER.open(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:600]
        raise RuntimeError(f"Ollama HTTP {error.code}: {detail}") from error


def write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".pid{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def write_jsonl_atomic(path: Path, rows: list[dict]) -> None:
    temporary = path.with_name(path.name + f".pid{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_sources() -> tuple[dict[str, dict[str, dict]], dict[str, str]]:
    sources: dict[str, dict[str, dict]] = {}
    hashes: dict[str, str] = {}
    for condition, source_path in SOURCE_FILES.items():
        raw = source_path.read_bytes()
        rows = [json.loads(line) for line in raw.decode("utf-8-sig").splitlines() if line.strip()]
        by_uid = {str(row["id"]): row for row in rows}
        if len(rows) != 172 or len(by_uid) != 172:
            raise RuntimeError(f"{condition}: expected 172 unique source rows")
        if any(row.get("use_local_tools") is not False or row.get("oracle_parsed_pages_included") is not True for row in rows):
            raise RuntimeError(f"{condition}: frozen source is not no-tools/oracle-page")
        hashes[condition] = sha256(raw)
        sources[condition] = by_uid

    baseline = sources["no-skill"]
    for condition in CONDITIONS[1:]:
        if set(sources[condition]) != set(baseline):
            raise RuntimeError(f"{condition}: source UID set differs")
        for uid, row in sources[condition].items():
            reference = baseline[uid]
            for key in ("question", "ground_truth", "source_files", "target_user_prompt"):
                if row.get(key) != reference.get(key):
                    raise RuntimeError(f"{condition} {uid}: {key} differs")
    official_text = OFFICIAL_SKILL.read_text(encoding="utf-8-sig").strip()
    if any(official_text not in row["target_system_prompt"] for row in sources["official-gpt55"].values()):
        raise RuntimeError("Official GPT-5.5 Skill is not present in every frozen system prompt")
    return sources, hashes


def final_answer(text: str) -> str:
    if "<answer>" not in text.lower():
        return ""
    match = _ANSWER.search(text)
    if match:
        return match.group(1).strip()
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1] if lines else text.strip()


def chat(model: str, row: dict) -> dict:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": row["target_system_prompt"]},
            {"role": "user", "content": row["target_user_prompt"] + USER_SUFFIX},
        ],
        "stream": False,
        "think": False,
        "keep_alive": "10m",
        "options": {
            "num_ctx": NUM_CTX,
            "num_predict": NUM_PREDICT,
            "temperature": TEMPERATURE,
            "seed": SEED,
        },
    }
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            return request_json("/api/chat", payload, timeout=900)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, RuntimeError) as error:
            last_error = error
            print(f"retry attempt={attempt + 1} error={type(error).__name__}: {str(error)[:220]}", flush=True)
            if attempt < 2:
                time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"Ollama request failed after 3 attempts: {last_error}")


def run_condition(model: str, condition: str, mode: str, limit: int, sources: dict, hashes: dict) -> None:
    scope = "smoke" if mode == "smoke" else "full"
    root = OUTPUT_ROOT / scope / model.replace(":", "-") / condition
    cases = root / "cases"
    cases.mkdir(parents=True, exist_ok=True)
    model_metadata = request_json("/api/tags")["models"]
    matching = [item for item in model_metadata if item.get("name") == model]
    if len(matching) != 1:
        raise RuntimeError(f"Ollama model not found exactly once: {model}")
    expected_manifest = {
        "schema": "auto-evolve/officeqa-ollama-native-consumer/v1",
        "model": model,
        "modelDigest": matching[0]["digest"],
        "condition": condition,
        "mode": scope,
        "split": "valid_unseen",
        "targetBackend": "ollama-native-chat",
        "targetBaseUrl": API_ROOT,
        "useLocalTools": False,
        "oracleParsedPages": True,
        # Existing three-condition manifests must remain resumable after adding this control.
        "inputSha256": hashes if condition == "official-gpt55" else {
            name: hashes[name] for name in ORIGINAL_CONDITIONS
        },
        "scorerSha256": sha256((SKILLOPT_ROOT / "skillopt/envs/officeqa/evaluator.py").read_bytes()),
        "numCtx": NUM_CTX,
        "numPredict": NUM_PREDICT,
        "sharedUserSuffix": USER_SUFFIX,
        "temperature": TEMPERATURE,
        "seed": SEED,
        "think": False,
    }
    if condition == "official-gpt55":
        expected_manifest["officialSkillSha256"] = sha256(OFFICIAL_SKILL.read_bytes())
    manifest = root / "manifest.json"
    if manifest.exists():
        if json.loads(manifest.read_text(encoding="utf-8-sig")) != expected_manifest:
            raise RuntimeError(f"Resume protocol mismatch: {manifest}")
    else:
        write_json_atomic(manifest, expected_manifest)

    ids = [SMOKE_UID] if mode == "smoke" else sorted(sources[condition])
    if limit > 0:
        ids = ids[:limit]
    for index, uid in enumerate(ids, start=1):
        case_path = cases / f"{uid}.json"
        if case_path.exists():
            stored = json.loads(case_path.read_text(encoding="utf-8-sig"))
            if stored.get("inputSha256") != sha256(
                (sources[condition][uid]["target_system_prompt"] + "\0" + sources[condition][uid]["target_user_prompt"] + USER_SUFFIX).encode("utf-8")
            ):
                raise RuntimeError(f"Input fingerprint mismatch for {model}/{condition}/{uid}")
            continue

        source = sources[condition][uid]
        started = time.monotonic()
        try:
            response = chat(model, source)
        except Exception as error:
            write_json_atomic(
                root / "infra-errors" / f"{uid}-{time.time_ns()}.json",
                {"uid": uid, "error": str(error), "at": time.time()},
            )
            raise
        elapsed = time.monotonic() - started
        if response.get("model") != model or response.get("done") is not True:
            raise RuntimeError(f"Invalid Ollama model or completion status for {model}/{uid}")
        prompt_tokens = int(response.get("prompt_eval_count") or 0)
        if prompt_tokens <= 0 or prompt_tokens >= NUM_CTX - NUM_PREDICT - 256:
            write_json_atomic(root / "infra-error.json", {
                "uid": uid,
                "error": f"context budget unsafe: prompt_eval_count={prompt_tokens}, num_ctx={NUM_CTX}",
                "at": time.time(),
            })
            raise RuntimeError(f"Context budget unsafe for {model}/{condition}/{uid}: {prompt_tokens}")
        message = response.get("message") or {}
        content = str(message.get("content") or "")
        prediction = final_answer(content)
        verdict = evaluate(prediction, str(source["ground_truth"])) if prediction else {"em": 0.0, "f1": 0.0}
        result = {
            "id": uid,
            "question": source["question"],
            "ground_truth": source["ground_truth"],
            "source_files": source["source_files"],
            "inputSha256": sha256((source["target_system_prompt"] + "\0" + source["target_user_prompt"] + USER_SUFFIX).encode("utf-8")),
            "response": content,
            "thinking": str(message.get("thinking") or ""),
            "predicted_answer": prediction,
            "hard": int(verdict["em"]),
            "soft": float(verdict["f1"]),
            "agent_ok": bool(prediction),
            "fail_reason": "" if prediction else "Model did not produce a final answer",
            "done_reason": response.get("done_reason"),
            "prompt_eval_count": prompt_tokens,
            "eval_count": int(response.get("eval_count") or 0),
            "elapsed_s": round(elapsed, 3),
            "total_duration_ns": response.get("total_duration"),
            "prompt_eval_duration_ns": response.get("prompt_eval_duration"),
            "eval_duration_ns": response.get("eval_duration"),
            "num_ctx": NUM_CTX,
            "num_predict": NUM_PREDICT,
            "model": model,
            "use_local_tools": False,
            "oracle_parsed_pages_included": True,
        }
        write_json_atomic(case_path, result)
        write_json_atomic(root / "progress.json", {
            "model": model,
            "condition": condition,
            "completed": len(list(cases.glob("UID*.json"))),
            "expected": 1 if mode == "smoke" else 172,
            "lastUID": uid,
            "lastElapsedSeconds": round(elapsed, 3),
            "updatedAtUnix": time.time(),
        })
        print(f"{model} {condition} {index}/{len(ids)} {uid} hard={result['hard']} elapsed={elapsed:.1f}s prompt={prompt_tokens} output={result['eval_count']}", flush=True)

    completed = sorted(cases.glob("UID*.json"))
    if len(completed) == (1 if mode == "smoke" else 172):
        results = [json.loads(file.read_text(encoding="utf-8-sig")) for file in completed]
        if len({item["id"] for item in results}) != len(results):
            raise RuntimeError("Duplicate completed UID")
        write_jsonl_atomic(root / "results.jsonl", results)
        summary = {
            "schema": "auto-evolve/officeqa-ollama-native-eval-summary/v1",
            "model": model,
            "condition": condition,
            "n_items": len(results),
            "hard_correct": sum(item["hard"] for item in results),
            "hard": sum(item["hard"] for item in results) / len(results),
            "soft": sum(item["soft"] for item in results) / len(results),
            "no_final_answer": sum(not item["agent_ok"] for item in results),
            "length_stops": sum(item["done_reason"] == "length" for item in results),
            "prior_infrastructure_incidents": int((root / "infra-error.json").exists())
            + len(list((root / "infra-errors").glob("*.json"))) if (root / "infra-errors").exists()
            else int((root / "infra-error.json").exists()),
            "total_elapsed_s": round(sum(item["elapsed_s"] for item in results), 1),
        }
        write_json_atomic(root / "eval_summary.json", summary)
        print(f"COMPLETE {model} {condition} hard={summary['hard_correct']}/{summary['n_items']}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, choices=MODELS)
    parser.add_argument("--condition", choices=("all",) + CONDITIONS, default="all")
    parser.add_argument("--mode", choices=("smoke", "full"), required=True)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    if args.limit < 0 or args.limit > 172:
        raise SystemExit("--limit must be 0..172")
    sources, hashes = load_sources()
    selected = ORIGINAL_CONDITIONS if args.condition == "all" else (args.condition,)
    for condition in selected:
        run_condition(args.model, condition, args.mode, args.limit, sources, hashes)


if __name__ == "__main__":
    main()
