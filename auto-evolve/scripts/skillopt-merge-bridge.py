from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any


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

    config_path = Path(str(native.get("configPath") or "")).resolve()
    out_root = Path(str(native.get("outRoot") or "")).resolve()
    if not config_path.is_file():
        raise ValueError(f"Native SkillOpt config does not exist: {config_path}")
    out_root.mkdir(parents=True, exist_ok=True)
    warm_start_path = out_root / "aev-warm-start.md"
    warm_start_path.write_text(extract_core_skill(warm_start_package), encoding="utf-8", newline="\n")

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
        }
    )
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
    return {
        "enabled": True,
        "env": cfg.get("env"),
        "trainSize": train_size,
        "validationSize": val_size,
        "testSize": len(getattr(dataloader, "test_items", []) or []),
    }


def run(request: dict[str, Any]) -> dict[str, Any]:
    configure_optimizer(request)
    from skillopt.gradient.aggregate import merge_patches
    from skillopt.model import get_token_summary, reset_token_tracker

    reset_token_tracker()
    native_train = request.get("nativeTrain") if isinstance(request.get("nativeTrain"), dict) else {}
    provider_preflight_tokens = verify_optimizer_ready() if bool(native_train.get("enabled")) else {}
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
        raise ValueError(
            "SkillOpt hierarchical aggregate did not converge to exactly one complete skill candidate; "
            f"got {len(candidates or [])}. One or more aggregate calls likely used SkillOpt's fallback path."
        )
    candidate = candidates[0]
    if not isinstance(candidate, dict) or not str(candidate.get("new_skill") or "").strip():
        raise ValueError("SkillOpt candidate is missing new_skill")
    warm_start = str(candidate["new_skill"])
    aggregate_tokens = get_token_summary()
    final_skill, native_summary, native_tokens = run_native_train(request, warm_start)
    token_summary: dict[str, Any] = {
        "provider_preflight": provider_preflight_tokens,
        "warm_start_aggregate": aggregate_tokens,
        "native_train": native_tokens,
    }
    return {
        "schema": "auto-evolve/skillopt-merge-result/v1",
        "passed": True,
        "reasoning": str(merged.get("reasoning") or ""),
        "mergedSkill": final_skill,
        "warmStartSkill": warm_start,
        "nativeTrainSummary": native_summary,
        "nativeTrainOutRoot": str((request.get("nativeTrain") or {}).get("outRoot") or ""),
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
