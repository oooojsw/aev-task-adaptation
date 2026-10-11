from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable


FILE_START = '<!-- AEV_SKILL_FILE_START "CORE.md" -->'
FILE_END = "<!-- AEV_SKILL_FILE_END -->"


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp, path)


def configure_optimizer(request: dict[str, Any]) -> None:
    from skillopt.config import flatten_config, load_config
    from skillopt.model import (
        configure_azure_openai,
        configure_minimax_chat,
        configure_qwen_chat,
        set_optimizer_backend,
        set_optimizer_deployment,
        set_reasoning_effort,
    )

    config_path = str(request.get("skillOptConfigPath") or "").strip()
    if not config_path:
        raise ValueError("skillOptConfigPath is required")
    cfg = flatten_config(load_config(config_path))
    overrides = request.get("optimizer") if isinstance(request.get("optimizer"), dict) else {}
    backend = str(overrides.get("backend") or cfg.get("optimizer_backend") or "openai_chat").strip()
    model = str(overrides.get("model") or cfg.get("optimizer_model") or "").strip()
    if not model:
        raise ValueError("SkillOpt optimizer model is not configured")
    base_url = str(overrides.get("baseUrl") or "").strip()
    api_key_env = str(overrides.get("apiKeyEnv") or "").strip()
    api_key = os.environ.get(api_key_env, "") if api_key_env else ""
    if api_key_env and not api_key:
        raise ValueError(f"Configured optimizer API key environment variable is empty: {api_key_env}")

    configure_azure_openai(
        endpoint=cfg.get("azure_openai_endpoint") or cfg.get("azure_endpoint") or None,
        api_version=cfg.get("azure_openai_api_version") or cfg.get("azure_api_version") or None,
        api_key=cfg.get("azure_openai_api_key") or cfg.get("azure_api_key") or None,
        optimizer_endpoint=base_url or cfg.get("optimizer_azure_openai_endpoint") or None,
        optimizer_api_version=cfg.get("optimizer_azure_openai_api_version") or None,
        optimizer_api_key=api_key or cfg.get("optimizer_azure_openai_api_key") or None,
        optimizer_auth_mode=cfg.get("optimizer_azure_openai_auth_mode") or None,
    )
    configure_qwen_chat(
        optimizer_base_url=base_url or cfg.get("optimizer_qwen_chat_base_url") or cfg.get("qwen_chat_base_url") or None,
        optimizer_api_key=api_key or cfg.get("optimizer_qwen_chat_api_key") or cfg.get("qwen_chat_api_key") or None,
        optimizer_temperature=cfg.get("optimizer_qwen_chat_temperature", cfg.get("qwen_chat_temperature")),
        optimizer_timeout_seconds=cfg.get("optimizer_qwen_chat_timeout_seconds", cfg.get("qwen_chat_timeout_seconds")),
        optimizer_max_tokens=cfg.get("optimizer_qwen_chat_max_tokens", cfg.get("qwen_chat_max_tokens")),
        optimizer_enable_thinking=cfg.get("optimizer_qwen_chat_enable_thinking", cfg.get("qwen_chat_enable_thinking")),
    )
    configure_minimax_chat(
        base_url=base_url or cfg.get("minimax_base_url") or None,
        api_key=api_key or cfg.get("minimax_api_key") or None,
        temperature=cfg.get("minimax_temperature"),
        max_tokens=cfg.get("minimax_max_tokens"),
        enable_thinking=cfg.get("minimax_enable_thinking"),
    )
    set_optimizer_backend(backend)
    set_optimizer_deployment(model)
    set_reasoning_effort(str(overrides.get("reasoningEffort") or cfg.get("reasoning_effort") or "").strip() or None)


def verify_optimizer_ready() -> dict[str, Any]:
    """Fail before hierarchical fan-out when the provider cannot accept requests."""
    from skillopt.model import chat_optimizer, get_token_summary, reset_token_tracker

    reset_token_tracker()
    response, _ = chat_optimizer(
        system="Return valid JSON only.",
        user='Return exactly {"ok":true}.',
        max_completion_tokens=128,
        retries=1,
        stage="aev_native_provider_preflight",
    )
    if not str(response or "").strip():
        raise RuntimeError("SkillOpt optimizer provider preflight returned an empty response")
    summary = get_token_summary()
    reset_token_tracker()
    return summary


def extract_core_skill(package_text: str) -> str:
    marker = '<!-- AEV_SKILL_FILE_START "CORE.md" -->'
    start = package_text.find(marker)
    if start < 0:
        raise ValueError("Warm-start package does not contain CORE.md")
    content_start = start + len(marker)
    if package_text.startswith("\r\n", content_start):
        content_start += 2
    elif package_text.startswith("\n", content_start):
        content_start += 1
    end = package_text.find(FILE_END, content_start)
    if end < 0:
        raise ValueError("Warm-start CORE.md is missing its package end marker")
    return package_text[content_start:end].rstrip() + "\n"


def adapt_skill_for_native_runtime(skill_text: str) -> str:
    """Keep learned guidance while overriding instructions impossible in SkillOpt."""
    contract = """

---

## SkillOpt Native Runtime Contract (highest priority)

This training runtime is not the original Auto-Evolve workspace.

- The current question and its permitted document evidence are already supplied in the user prompt.
- When tools are available, use only the tools exposed by this runtime (`glob`, `read`, and `grep`).
- Do not run Python, shell commands, downloads, browsers, or external search unless the current runtime explicitly exposes them.
- Do not try to create `workspace/answer.txt` or any other file. Return the final answer directly in `<answer>...</answer>`.
- If older guidance conflicts with this runtime contract, follow this runtime contract while preserving the learned reasoning method.
""".strip()
    return f"{skill_text.rstrip()}\n\n{contract}\n"


def load_train_module(skillopt_root: Path):
    train_path = skillopt_root / "scripts" / "train.py"
    spec = importlib.util.spec_from_file_location("skillopt_native_train_entry", train_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load SkillOpt trainer entry: {train_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_native_train(request: dict[str, Any], warm_start_package: str) -> tuple[str, dict[str, Any], dict[str, Any]]:
    native = request.get("nativeTrain") if isinstance(request.get("nativeTrain"), dict) else {}
    if not native.get("enabled"):
        return warm_start_package, {}, {}

    from skillopt.config import flatten_config, load_config
    from skillopt.engine.trainer import ReflACTTrainer
    from skillopt.model import get_token_summary, reset_token_tracker
    from skillopt.optimizer.skill_length import SkillLengthPolicy, repair_skill_to_limit, utf8_bytes

    config_path = Path(str(native.get("configPath") or "")).resolve()
    out_root = Path(str(native.get("outRoot") or "")).resolve()
    if not config_path.is_file():
        raise ValueError(f"Native SkillOpt config does not exist: {config_path}")
    out_root.mkdir(parents=True, exist_ok=True)
    raw_warm_start_path = out_root / "aev-warm-start.raw.md"
    warm_start_path = out_root / "aev-warm-start.md"
    raw_warm_start = extract_core_skill(warm_start_package)
    raw_warm_start_path.write_text(raw_warm_start, encoding="utf-8", newline="\n")
    length_policy = SkillLengthPolicy.from_config(request.get("lengthPolicy"))
    adapted_warm_start, warm_start_length_events = repair_skill_to_limit(
        adapt_skill_for_native_runtime(raw_warm_start),
        length_policy,
        stage="native_runtime_warm_start",
        document_label="complete native-runtime skill preserving the runtime contract",
        required_substrings=("SkillOpt Native Runtime Contract", "<answer>...</answer>"),
    )
    warm_start_path.write_text(adapted_warm_start, encoding="utf-8", newline="\n")

    cfg = flatten_config(load_config(str(config_path)))
    if native.get("splitDir"):
        cfg["split_dir"] = str(Path(str(native["splitDir"])).resolve())
    if isinstance(native.get("dataDirs"), list) and native["dataDirs"]:
        cfg["data_dirs"] = [str(Path(str(item)).resolve()) for item in native["dataDirs"]]
    optimizer = request.get("optimizer") if isinstance(request.get("optimizer"), dict) else {}
    optimizer_backend = str(optimizer.get("backend") or cfg.get("optimizer_backend") or "").strip()
    optimizer_model = str(optimizer.get("model") or cfg.get("optimizer_model") or "").strip()
    target_backend = str(native.get("targetBackend") or optimizer_backend or cfg.get("target_backend") or "").strip()
    target_model = str(native.get("targetModel") or optimizer_model or cfg.get("target_model") or "").strip()
    optimizer_key_env = str(optimizer.get("apiKeyEnv") or "").strip()
    target_key_env = str(native.get("targetApiKeyEnv") or optimizer_key_env).strip()
    optimizer_key = os.environ.get(optimizer_key_env, "") if optimizer_key_env else ""
    target_key = os.environ.get(target_key_env, "") if target_key_env else ""
    if optimizer_key_env and not optimizer_key:
        raise ValueError(f"Optimizer API key environment variable is empty: {optimizer_key_env}")
    if target_key_env and not target_key:
        raise ValueError(f"Target API key environment variable is empty: {target_key_env}")
    if optimizer_backend == "minimax_chat" and optimizer_key:
        os.environ["MINIMAX_API_KEY"] = optimizer_key
    if target_backend == "minimax_chat" and target_key:
        if optimizer_key and target_key != optimizer_key:
            raise ValueError("SkillOpt MiniMax backend uses one process-wide key; optimizer and target keys must match")
        os.environ["MINIMAX_API_KEY"] = target_key

    cfg.update(
        {
            "skill_init": str(warm_start_path),
            "out_root": str(out_root),
            "num_epochs": int(native.get("epochs") or 4),
            "batch_size": int(native.get("batchSize") or 40),
            "max_steps": int(native.get("maxSteps") or 0),
            "eval_test": bool(native.get("evalTest", False)),
            "workers": int(native.get("targetWorkers") or 1),
            "optimizer_backend": optimizer_backend,
            "optimizer_model": optimizer_model,
            "target_backend": target_backend,
            "target_model": target_model,
            "skill_max_bytes": length_policy.max_bytes if length_policy.enabled else 0,
            "skill_length_repair_attempts": length_policy.max_repair_attempts,
        }
    )
    if "slowUpdateGateWithSelection" in native:
        # C阶段必须让慢更新和普通候选使用同一验证门禁。
        cfg["slow_update_gate_with_selection"] = bool(native["slowUpdateGateWithSelection"])
    base_url = str(optimizer.get("baseUrl") or "").strip()
    target_base_url = str(native.get("targetBaseUrl") or base_url).strip()
    if optimizer_backend == "minimax_chat" and base_url:
        cfg["minimax_base_url"] = base_url
    if target_backend == "minimax_chat" and target_base_url:
        if base_url and target_base_url != base_url:
            raise ValueError("SkillOpt MiniMax backend uses one process-wide base URL; optimizer and target URLs must match")
        cfg["minimax_base_url"] = target_base_url

    train_module = load_train_module(Path.cwd())
    adapter = train_module.get_adapter(cfg)
    reset_token_tracker()
    summary = ReflACTTrainer(cfg, adapter).train()
    best_skill_path = out_root / "best_skill.md"
    if not best_skill_path.is_file():
        raise ValueError("Native SkillOpt trainer completed without best_skill.md")
    best_skill = best_skill_path.read_text(encoding="utf-8-sig")
    if length_policy.enabled and utf8_bytes(best_skill) > length_policy.max_bytes:
        raise ValueError(
            f"Native SkillOpt best skill exceeds hard limit: {utf8_bytes(best_skill)} > "
            f"{length_policy.max_bytes} UTF-8 bytes"
        )
    summary["bridgeLengthGate"] = {
        "policy": length_policy.to_dict(),
        "warmStartEvents": warm_start_length_events,
        "finalBestSkillBytes": utf8_bytes(best_skill),
    }
    summary["bridgeSelectionGate"] = {
        "slowUpdateGateWithSelection": bool(cfg.get("slow_update_gate_with_selection", False)),
    }
    packaged = f"{FILE_START}\n{best_skill.rstrip()}\n{FILE_END}"
    return packaged, summary, get_token_summary()


def preflight_native_train(request: dict[str, Any]) -> dict[str, Any]:
    native = request.get("nativeTrain") if isinstance(request.get("nativeTrain"), dict) else {}
    if not native.get("enabled"):
        return {"enabled": False}
    from skillopt.config import flatten_config, load_config

    config_path = Path(str(native.get("configPath") or "")).resolve()
    if not config_path.is_file():
        raise ValueError(f"Native SkillOpt config does not exist: {config_path}")
    cfg = flatten_config(load_config(str(config_path)))
    if native.get("splitDir"):
        cfg["split_dir"] = str(Path(str(native["splitDir"])).resolve())
    if isinstance(native.get("dataDirs"), list) and native["dataDirs"]:
        cfg["data_dirs"] = [str(Path(str(item)).resolve()) for item in native["dataDirs"]]
    cfg["out_root"] = str(Path(str(native.get("outRoot") or ".native-preflight")).resolve())
    cfg["workers"] = int(native.get("targetWorkers") or 1)
    train_module = load_train_module(Path.cwd())
    adapter = train_module.get_adapter(cfg)
    adapter.setup(cfg)
    dataloader = adapter.get_dataloader()
    train_size = len(getattr(dataloader, "train_items", []) or []) if dataloader is not None else 0
    val_size = len(getattr(dataloader, "val_items", []) or []) if dataloader is not None else 0
    if train_size < 1 or val_size < 1:
        raise ValueError(f"Native SkillOpt split is incomplete: train={train_size}, val={val_size}")
    evidence_coverage: dict[str, Any] = {}
    if str(cfg.get("env") or "").strip().lower() == "officeqa":
        from skillopt.envs.officeqa.tool_runtime import (
            build_oracle_parsed_pages_context,
            resolve_candidate_files,
            resolve_docs_roots,
        )

        configured_dirs = [Path(str(item)).resolve() for item in cfg.get("data_dirs", [])]
        material_file_count = sum(
            1
            for root in configured_dirs
            if root.is_dir()
            for candidate in root.rglob("*")
            if candidate.is_file()
        )
        if material_file_count < 1:
            raise ValueError(
                "Native SkillOpt OfficeQA material directories contain no files: "
                + ", ".join(str(item) for item in configured_dirs)
            )
        docs_roots = resolve_docs_roots([str(item) for item in configured_dirs])

        def inspect_split(label: str, items: list[dict[str, Any]]) -> dict[str, Any]:
            uncovered: list[str] = []
            resolved_file_items = 0
            oracle_items = 0
            for item in items:
                candidate_files = resolve_candidate_files(item.get("source_files", []), docs_roots)
                oracle_context = build_oracle_parsed_pages_context(
                    item.get("source_files", []),
                    item.get("source_docs", []),
                    docs_roots,
                )
                if candidate_files:
                    resolved_file_items += 1
                if oracle_context:
                    oracle_items += 1
                if not candidate_files and not oracle_context:
                    uncovered.append(str(item.get("id") or "<missing-id>"))
            if uncovered:
                preview = ", ".join(uncovered[:12])
                suffix = "" if len(uncovered) <= 12 else f" (+{len(uncovered) - 12} more)"
                raise ValueError(
                    f"Native SkillOpt OfficeQA {label} evidence coverage is incomplete: "
                    f"{len(uncovered)}/{len(items)} items have neither a resolved source file nor oracle parsed pages: "
                    f"{preview}{suffix}"
                )
            return {
                "totalItems": len(items),
                "coveredItems": len(items) - len(uncovered),
                "resolvedFileItems": resolved_file_items,
                "oracleContextItems": oracle_items,
            }

        evidence_coverage = {
            "materialFileCount": material_file_count,
            "resolvedDocumentRoots": docs_roots,
            "train": inspect_split("train", list(getattr(dataloader, "train_items", []) or [])),
            "validation": inspect_split("validation", list(getattr(dataloader, "val_items", []) or [])),
        }
    return {
        "enabled": True,
        "env": cfg.get("env"),
        "trainSize": train_size,
        "validationSize": val_size,
        "testSize": len(getattr(dataloader, "test_items", []) or []),
        "evidenceCoverage": evidence_coverage,
    }


def converge_skill_candidates(
    merge_patches_fn,
    request: dict[str, Any],
    merged: dict[str, Any],
    *,
    max_attempts: int = 8,
    strict_finalizer_fn: Callable[[list[dict[str, Any]]], dict[str, Any]] | None = None,
    checkpoint_fn: Callable[[dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], int]:
    """Use SkillOpt's own aggregate again when its fallback leaves multiple candidates."""
    attempts = 0
    current = merged
    while True:
        candidates = current.get("skill_candidates") if isinstance(current, dict) else None
        if isinstance(candidates, list) and len(candidates) == 1:
            return current, attempts
        if not isinstance(candidates, list) or not candidates:
            raise ValueError(
                "SkillOpt hierarchical aggregate returned no complete skill candidate; "
                "the aggregate response could not be safely recovered."
            )
        if attempts >= max_attempts:
            if strict_finalizer_fn is not None:
                strict = strict_finalizer_fn(candidates)
                strict_candidates = strict.get("skill_candidates") if isinstance(strict, dict) else None
                if isinstance(strict_candidates, list) and len(strict_candidates) == 1:
                    return strict, attempts + 1
            raise ValueError(
                "SkillOpt hierarchical aggregate did not converge to exactly one complete skill candidate; "
                f"got {len(candidates)} after {attempts} final-consolidation attempts."
            )

        retry_patches = [
            {
                "reasoning": f"final-consolidation input {index + 1}/{len(candidates)}",
                "skill_candidates": [candidate],
            }
            for index, candidate in enumerate(candidates)
            if isinstance(candidate, dict) and str(candidate.get("new_skill") or "").strip()
        ]
        if len(retry_patches) != len(candidates):
            raise ValueError(
                "SkillOpt hierarchical aggregate returned malformed candidates; "
                "refusing to choose or concatenate an incomplete skill."
            )

        attempts += 1
        current = merge_patches_fn(
            skill_content=str(request.get("skillContent") or ""),
            failure_patches=[],
            success_patches=retry_patches,
            # The normal aggregate may leave several very large complete skills when its
            # final all-at-once call exceeds the provider context. Pairwise consolidation
            # keeps each native SkillOpt merge call bounded while preserving every input.
            batch_size=2,
            workers=max(1, int(request.get("workers") or 1)),
            update_mode="full_rewrite_minibatch",
            meta_skill_context=(
                f"{str(request.get('metaSkillContext') or '')}\n\n"
                f"Final consolidation attempt {attempts}/{max_attempts}: merge every complete candidate into exactly "
                "one coherent replacement skill candidate. Deduplicate and generalize overlapping rules; preserve "
                "coverage rather than copying every sentence. The final new_skill should be concise (target at most "
                "60,000 characters). Do not return one candidate per input."
            ).strip(),
            length_policy=request.get("lengthPolicy"),
        )
        if checkpoint_fn is not None:
            checkpoint_fn(current)


def force_pairwise_skill_consolidation(
    candidates: list[dict[str, Any]],
    length_policy_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Strictly reduce complete candidates 2->1 without concatenation fallback."""
    from skillopt.model import chat_optimizer
    from skillopt.optimizer.skill_length import SkillLengthPolicy, repair_skill_to_limit
    from skillopt.utils.json_utils import extract_json

    length_policy = SkillLengthPolicy.from_config(length_policy_config)
    current = list(candidates)
    level = 0
    while len(current) > 1:
        level += 1
        next_level: list[dict[str, Any]] = []
        for offset in range(0, len(current), 2):
            pair = current[offset: offset + 2]
            if len(pair) == 1:
                next_level.append(pair[0])
                continue
            user = (
                "Merge these two complete AEV skill candidates into exactly one concise replacement skill. "
                "Deduplicate and generalize overlapping rules while preserving reusable task coverage. "
                "Remove task IDs, answers, absolute paths, and runtime-only instructions. Target at most 30,000 "
                "characters in new_skill. Preserve the AEV_SKILL_FILE_START/END package markers.\n\n"
                + json.dumps(pair, ensure_ascii=False)
            )
            merged_candidate: dict[str, Any] | None = None
            last_error = "no valid response"
            for retry in range(1, 4):
                response, _ = chat_optimizer(
                    system=(
                        "Return valid JSON only with keys reasoning and skill_candidates. "
                        "skill_candidates must contain exactly one object with new_skill."
                    ),
                    user=user,
                    max_completion_tokens=32000,
                    retries=2,
                    stage="merge_strict_pairwise_finalizer",
                )
                parsed = extract_json(str(response or ""))
                parsed_candidates = parsed.get("skill_candidates") if isinstance(parsed, dict) else None
                if isinstance(parsed_candidates, list) and len(parsed_candidates) == 1:
                    candidate = parsed_candidates[0]
                    skill = str(candidate.get("new_skill") or "") if isinstance(candidate, dict) else ""
                    if FILE_START in skill and FILE_END in skill:
                        skill, _ = repair_skill_to_limit(
                            skill,
                            length_policy,
                            stage=f"strict_pairwise_level_{level}_pair_{offset // 2 + 1}",
                            document_label="complete packaged skill preserving AEV file markers",
                            required_substrings=(FILE_START, FILE_END),
                        )
                        if FILE_START not in skill or FILE_END not in skill:
                            raise ValueError("Length repair removed required AEV package markers")
                        candidate["new_skill"] = skill
                        merged_candidate = candidate
                        break
                last_error = f"retry {retry} did not return one complete packaged skill"
            if merged_candidate is None:
                raise ValueError(
                    f"Strict pairwise finalizer failed at level {level}, pair {offset // 2 + 1}: {last_error}"
                )
            next_level.append(merged_candidate)
        current = next_level
    return {
        "reasoning": f"Strict pairwise finalizer converged in {level} levels",
        "skill_candidates": current,
    }


def source_candidate_digest(request: dict[str, Any]) -> str:
    # 长度策略进入指纹，防止复用旧的无上限断点。
    payload = {
        "skillContent": request.get("skillContent") or "",
        "failurePatches": request.get("failurePatches") or [],
        "successPatches": request.get("successPatches") or [],
        "metaSkillContext": request.get("metaSkillContext") or "",
        "batchSize": int(request.get("batchSize") or 8),
        "lengthPolicy": request.get("lengthPolicy") or {},
        "bridgeProtocol": "length-gate-v1",
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def run(request: dict[str, Any]) -> dict[str, Any]:
    native_preflight = preflight_native_train(request)
    configure_optimizer(request)
    from skillopt.gradient.aggregate import merge_patches
    from skillopt.model import get_token_summary, reset_token_tracker
    from skillopt.optimizer.skill_length import SkillLengthPolicy, repair_skill_to_limit, utf8_bytes

    reset_token_tracker()
    native_train = request.get("nativeTrain") if isinstance(request.get("nativeTrain"), dict) else {}
    provider_preflight_tokens = verify_optimizer_ready() if bool(native_train.get("enabled")) else {}
    reuse_warm_start_path = Path(str(native_train.get("reuseWarmStartPath") or "")).resolve()
    if str(native_train.get("reuseWarmStartPath") or "").strip():
        if not reuse_warm_start_path.is_file():
            raise ValueError(f"Reusable SkillOpt warm-start does not exist: {reuse_warm_start_path}")
        reused_text = reuse_warm_start_path.read_text(encoding="utf-8-sig").strip()
        if not reused_text:
            raise ValueError(f"Reusable SkillOpt warm-start is empty: {reuse_warm_start_path}")
        warm_start = (
            reused_text
            if FILE_START in reused_text
            else f"{FILE_START}\n{reused_text}\n{FILE_END}"
        )
        consolidation_attempts = 0
        merged_reasoning = f"Reused audited warm-start from {reuse_warm_start_path}"
        aggregate_tokens = {"reusedWarmStart": True, "calls": 0}
    else:
        source_digest = source_candidate_digest(request)
        native_out = Path(str(native_train.get("outRoot") or ".native-train")).resolve()
        checkpoint_path = native_out / "warm-start-convergence-checkpoint.json"
        checkpoint = read_json(checkpoint_path) if checkpoint_path.is_file() else {}
        if checkpoint.get("sourceDigest") == source_digest and isinstance(checkpoint.get("current"), dict):
            merged = checkpoint["current"]
            aggregate_tokens = {
                "reusedConvergenceCheckpoint": True,
                "checkpointPath": str(checkpoint_path),
                "calls": 0,
            }
        else:
            merged = merge_patches(
                skill_content=str(request.get("skillContent") or ""),
                failure_patches=request.get("failurePatches") or [],
                success_patches=request.get("successPatches") or [],
                batch_size=int(request.get("batchSize") or 8),
                workers=int(request.get("workers") or 1),
                update_mode="full_rewrite_minibatch",
                meta_skill_context=str(request.get("metaSkillContext") or ""),
                length_policy=request.get("lengthPolicy"),
            )
            write_json(
                checkpoint_path,
                {
                    "schema": "auto-evolve/skillopt-warm-start-checkpoint/v1",
                    "sourceDigest": source_digest,
                    "status": "aggregate_pending_convergence",
                    "current": merged,
                },
            )
            aggregate_tokens = get_token_summary()
        merged, consolidation_attempts = converge_skill_candidates(
            merge_patches,
            request,
            merged,
            strict_finalizer_fn=lambda candidates: force_pairwise_skill_consolidation(
                candidates,
                request.get("lengthPolicy"),
            ),
            checkpoint_fn=lambda current: write_json(
                checkpoint_path,
                {
                    "schema": "auto-evolve/skillopt-warm-start-checkpoint/v1",
                    "sourceDigest": source_digest,
                    "status": "convergence_in_progress",
                    "current": current,
                },
            ),
        )
        write_json(
            checkpoint_path,
            {
                "schema": "auto-evolve/skillopt-warm-start-checkpoint/v1",
                "sourceDigest": source_digest,
                "status": "converged",
                "current": merged,
            },
        )
        candidates = merged.get("skill_candidates")
        candidate = candidates[0]
        if not isinstance(candidate, dict) or not str(candidate.get("new_skill") or "").strip():
            raise ValueError("SkillOpt candidate is missing new_skill")
        warm_start = str(candidate["new_skill"])
        merged_reasoning = str(merged.get("reasoning") or "")
        current_aggregate_tokens = get_token_summary()
        if aggregate_tokens.get("reusedConvergenceCheckpoint"):
            aggregate_tokens["resumeTokenSummary"] = current_aggregate_tokens
        else:
            aggregate_tokens = current_aggregate_tokens
    length_policy = SkillLengthPolicy.from_config(request.get("lengthPolicy"))
    warm_start, warm_start_length_events = repair_skill_to_limit(
        warm_start,
        length_policy,
        stage="bridge_warm_start_final",
        document_label="complete packaged skill preserving AEV file markers",
        required_substrings=(FILE_START, FILE_END),
    )
    if length_policy.enabled and (FILE_START not in warm_start or FILE_END not in warm_start):
        raise ValueError("Length repair removed required AEV package markers")
    final_skill, native_summary, native_tokens = run_native_train(request, warm_start)
    token_summary: dict[str, Any] = {
        "provider_preflight": provider_preflight_tokens,
        "warm_start_aggregate": aggregate_tokens,
        "native_train": native_tokens,
    }
    return {
        "schema": "auto-evolve/skillopt-merge-result/v1",
        "passed": True,
        "reasoning": merged_reasoning,
        "mergedSkill": final_skill,
        "warmStartSkill": warm_start,
        "warmStartConsolidationAttempts": consolidation_attempts,
        "lengthGate": {
            "policy": length_policy.to_dict(),
            "warmStartBytes": utf8_bytes(warm_start),
            "warmStartEvents": warm_start_length_events,
        },
        "nativeTrainSummary": native_summary,
        "nativeTrainOutRoot": str((request.get("nativeTrain") or {}).get("outRoot") or ""),
        "nativeTrainPreflight": native_preflight,
        "tokenSummary": token_summary,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge AEV full-skill candidates into SkillOpt hierarchical merge.")
    parser.add_argument("--skillopt-root", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()

    skillopt_root = Path(args.skillopt_root).resolve()
    request_path = Path(args.request).resolve()
    result_path = Path(args.result).resolve()
    if not skillopt_root.is_dir() or not (skillopt_root / "skillopt").is_dir():
        raise SystemExit(f"Invalid SkillOpt root: {skillopt_root}")
    sys.path.insert(0, str(skillopt_root))
    os.chdir(skillopt_root)
    try:
        request = read_json(request_path)
        if args.preflight_only:
            configure_optimizer(request)
            native_preflight = preflight_native_train(request)
            write_json(
                result_path,
                {
                    "schema": "auto-evolve/skillopt-merge-result/v1",
                    "passed": True,
                    "reasoning": "SkillOpt bridge preflight passed without a model request.",
                    "nativeTrainPreflight": native_preflight,
                },
            )
        else:
            write_json(result_path, run(request))
        return 0
    except Exception as error:  # noqa: BLE001
        write_json(
            result_path,
            {
                "schema": "auto-evolve/skillopt-merge-result/v1",
                "passed": False,
                "error": str(error),
                "traceback": traceback.format_exc(),
            },
        )
        print(traceback.format_exc(), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
