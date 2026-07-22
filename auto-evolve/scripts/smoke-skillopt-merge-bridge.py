from __future__ import annotations

import importlib.util
import sys
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
finally:
    for name, module in old_modules.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module

print("smoke-skillopt-merge-bridge: passed")
