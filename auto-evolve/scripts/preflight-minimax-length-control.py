"""Make one minimal authenticated MiniMax call without persisting credentials."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    key_name = "AEV_LENGTH_CONTROL_MINIMAX_KEY"
    api_key = os.environ.get(key_name, "").strip()
    if not api_key:
        raise RuntimeError(f"Missing required environment variable: {key_name}")

    skillopt_root = Path(os.environ.get("AEV_LENGTH_CONTROL_SKILLOPT_ROOT", "E:/project/SkillOpt-length-cap")).resolve()
    if not (skillopt_root / "skillopt").is_dir():
        raise RuntimeError(f"SkillOpt length-control checkout is unavailable: {skillopt_root}")
    sys.path.insert(0, str(skillopt_root))

    from skillopt.model import chat_optimizer, configure_minimax_chat, set_optimizer_backend, set_optimizer_deployment

    # 预检与正式训练共用同一模型链路，避免“配置可读但账号不可用”。
    set_optimizer_backend("minimax_chat")
    set_optimizer_deployment("MiniMax-M2.7")
    configure_minimax_chat(
        base_url="https://api.minimaxi.com/anthropic/v1",
        api_key=api_key,
        max_tokens=32,
        enable_thinking=False,
    )
    response, usage = chat_optimizer(
        system="Return the exact requested token only.",
        user="Return exactly: LENGTH_CONTROL_PREFLIGHT_OK",
        max_completion_tokens=32,
        retries=1,
        stage="length_control_preflight",
        timeout=60,
    )
    if "LENGTH_CONTROL_PREFLIGHT_OK" not in response:
        raise RuntimeError("MiniMax preflight returned an unexpected response")
    print(json.dumps({"ok": True, "model": "MiniMax-M2.7", "usage": usage}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=True), file=sys.stderr)
        raise SystemExit(1)
