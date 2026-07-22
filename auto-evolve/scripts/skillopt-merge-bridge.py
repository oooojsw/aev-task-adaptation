from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any


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


def run(request: dict[str, Any]) -> dict[str, Any]:
    configure_optimizer(request)
    from skillopt.gradient.aggregate import merge_patches
    from skillopt.model import get_token_summary, reset_token_tracker

    reset_token_tracker()
    merged = merge_patches(
        skill_content=str(request.get("skillContent") or ""),
        failure_patches=request.get("failurePatches") or [],
        success_patches=request.get("successPatches") or [],
        batch_size=int(request.get("batchSize") or 8),
        workers=int(request.get("workers") or 1),
        update_mode="full_rewrite_minibatch",
        meta_skill_context=str(request.get("metaSkillContext") or ""),
    )
    candidates = merged.get("skill_candidates") if isinstance(merged, dict) else None
    if not isinstance(candidates, list) or len(candidates) != 1:
        raise ValueError(f"SkillOpt must return exactly one complete skill candidate; got {len(candidates or [])}")
    candidate = candidates[0]
    if not isinstance(candidate, dict) or not str(candidate.get("new_skill") or "").strip():
        raise ValueError("SkillOpt candidate is missing new_skill")
    return {
        "schema": "auto-evolve/skillopt-merge-result/v1",
        "passed": True,
        "reasoning": str(merged.get("reasoning") or ""),
        "mergedSkill": str(candidate["new_skill"]),
        "tokenSummary": get_token_summary(),
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
            write_json(
                result_path,
                {
                    "schema": "auto-evolve/skillopt-merge-result/v1",
                    "passed": True,
                    "reasoning": "SkillOpt bridge preflight passed without a model request.",
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
