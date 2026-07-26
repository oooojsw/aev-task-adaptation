from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
from pathlib import Path


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


root = Path(__file__).resolve().parents[2]
bridge_path = root / "auto-evolve" / "scripts" / "skillopt-merge-bridge.py"
spec = importlib.util.spec_from_file_location("aev_skillopt_merge_bridge_smoke", bridge_path)
assert_true(spec is not None and spec.loader is not None, f"Unable to import bridge: {bridge_path}")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

adapted = bridge.adapt_skill_for_native_runtime("# Learned method\n")
assert_true("# Learned method" in adapted, "Runtime adapter must preserve the learned skill")
assert_true("highest priority" in adapted, "Runtime adapter must declare precedence")
assert_true("<answer>...</answer>" in adapted, "Runtime adapter must define the SkillOpt answer contract")
assert_true("Do not run Python" in adapted, "Runtime adapter must disable unavailable AEV tools")

with tempfile.TemporaryDirectory() as temp_root:
    reusable = Path(temp_root) / "warm-start.md"
    reusable.write_text("# Reused warm start\n", encoding="utf-8")
    assert_true(reusable.is_file(), "Reusable warm-start fixture was not created")

candidate_inputs = [
    {"new_skill": f"<!-- AEV_SKILL_FILE_START \"CORE.md\" -->\n# Candidate {index}\n<!-- AEV_SKILL_FILE_END -->"}
    for index in range(5)
]
consolidation_calls: list[dict] = []


def converging_merge(**kwargs):
    consolidation_calls.append(kwargs)
    return {
        "reasoning": "strict final consolidation",
        "skill_candidates": [
            {
                "new_skill": (
                    "<!-- AEV_SKILL_FILE_START \"CORE.md\" -->\n"
                    "# Consolidated\n"
                    "<!-- AEV_SKILL_FILE_END -->"
                )
            }
        ],
    }


converged, attempts = bridge.converge_skill_candidates(
    converging_merge,
    {"batchSize": 8, "workers": 2, "skillContent": "# Seed"},
    {"reasoning": "fallback concatenation", "skill_candidates": candidate_inputs},
)
assert_true(attempts == 1, f"Expected one final-consolidation attempt, got {attempts}")
assert_true(len(converged["skill_candidates"]) == 1, "Final consolidation must produce exactly one candidate")
assert_true(len(consolidation_calls[0]["success_patches"]) == 5, "All fallback candidates must be preserved")
assert_true(consolidation_calls[0]["batch_size"] == 2, "Fallback recovery must consolidate large skills pairwise")


def nonconverging_merge(**_kwargs):
    return {"reasoning": "fallback concatenation", "skill_candidates": candidate_inputs}


try:
    bridge.converge_skill_candidates(
        nonconverging_merge,
        {"batchSize": 8, "workers": 2, "skillContent": "# Seed"},
        {"reasoning": "fallback concatenation", "skill_candidates": candidate_inputs},
        max_attempts=2,
    )
except ValueError as error:
    assert_true("after 2 final-consolidation attempts" in str(error), f"Unexpected failure: {error}")
else:
    raise AssertionError("Persistent multi-candidate fallback must fail closed")

calls = {"aggregate": 0, "chat": 0, "reset": 0}


def reset_token_tracker() -> None:
    calls["reset"] += 1


def get_token_summary() -> dict[str, int]:
    return {"calls": calls["chat"]}


def chat_optimizer(*_args, **_kwargs):
    calls["chat"] += 1
    raise RuntimeError("HTTP 429 Token Plan total quota exhausted")


def noop(*_args, **_kwargs) -> None:
    return None


def merge_patches(*_args, **_kwargs):
    calls["aggregate"] += 1
    return {
        "reasoning": "should not be reached before provider preflight succeeds",
        "skill_candidates": [{"new_skill": "<!-- AEV_SKILL_FILE_START \"CORE.md\" -->\n# Core\n<!-- AEV_SKILL_FILE_END -->"}],
    }


skillopt_pkg = types.ModuleType("skillopt")
skillopt_pkg.__path__ = []
config_mod = types.ModuleType("skillopt.config")
config_mod.flatten_config = lambda value: dict(value)
config_mod.load_config = lambda _path: {"optimizer_backend": "mock_backend", "optimizer_model": "mock_model"}
model_mod = types.ModuleType("skillopt.model")
model_mod.configure_azure_openai = noop
model_mod.configure_minimax_chat = noop
model_mod.configure_qwen_chat = noop
model_mod.set_optimizer_backend = noop
model_mod.set_optimizer_deployment = noop
model_mod.set_reasoning_effort = noop
model_mod.chat_optimizer = chat_optimizer
model_mod.get_token_summary = get_token_summary
model_mod.reset_token_tracker = reset_token_tracker
gradient_pkg = types.ModuleType("skillopt.gradient")
aggregate_mod = types.ModuleType("skillopt.gradient.aggregate")
aggregate_mod.merge_patches = merge_patches

old_modules = {
    name: sys.modules.get(name)
    for name in ["skillopt", "skillopt.config", "skillopt.model", "skillopt.gradient", "skillopt.gradient.aggregate"]
}
sys.modules["skillopt"] = skillopt_pkg
sys.modules["skillopt.config"] = config_mod
sys.modules["skillopt.model"] = model_mod
sys.modules["skillopt.gradient"] = gradient_pkg
sys.modules["skillopt.gradient.aggregate"] = aggregate_mod

try:
    original_preflight = bridge.preflight_native_train
    original_provider_preflight = bridge.verify_optimizer_ready
    original_run_native_train = bridge.run_native_train
    bridge.preflight_native_train = lambda _request: {
        "enabled": True,
        "trainSize": 1,
        "validationSize": 1,
    }
    try:
        bridge.run(
            {
                "skillOptConfigPath": "mock-config.yaml",
                "nativeTrain": {"enabled": True},
                "successPatches": [],
                "failurePatches": [],
            }
        )
    except RuntimeError as error:
        assert_true("429" in str(error), f"Expected provider error to propagate, got: {error}")
    else:
        raise AssertionError("Expected provider preflight failure")

    assert_true(calls["chat"] == 1, f"Expected exactly one provider preflight call, got {calls['chat']}")
    assert_true(calls["aggregate"] == 0, "Provider preflight failure must stop before hierarchical aggregation")
    assert_true(calls["reset"] >= 1, "Token tracker should be reset for preflight accounting")

    with tempfile.TemporaryDirectory() as temp_root:
        reusable = Path(temp_root) / "reusable-warm-start.md"
        reusable.write_text("# Reused warm start\n", encoding="utf-8")
        bridge.verify_optimizer_ready = lambda: {}
        bridge.run_native_train = lambda _request, package: (
            package,
            {"completed": True},
            {"calls": 0},
        )
        reused_result = bridge.run(
            {
                "skillOptConfigPath": "mock-config.yaml",
                "nativeTrain": {
                    "enabled": True,
                    "reuseWarmStartPath": str(reusable),
                },
                "successPatches": [],
                "failurePatches": [],
            }
        )
        assert_true(calls["aggregate"] == 0, "Reusable warm-start must bypass hierarchical aggregation")
        assert_true("Reused warm start" in reused_result["mergedSkill"], "Reusable warm-start content was lost")
        assert_true(
            reused_result["tokenSummary"]["warm_start_aggregate"]["reusedWarmStart"] is True,
            "Reusable warm-start lineage marker is missing",
        )
finally:
    bridge.preflight_native_train = original_preflight
    bridge.verify_optimizer_ready = original_provider_preflight
    bridge.run_native_train = original_run_native_train
    for name, module in old_modules.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module

print("smoke-skillopt-merge-bridge: passed")
