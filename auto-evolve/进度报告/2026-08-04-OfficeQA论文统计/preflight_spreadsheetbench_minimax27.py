from __future__ import annotations

import json
import sys
from pathlib import Path


SKILLOPT = Path(r"C:\Users\ZhuanZ\Desktop\SkillOpt")
AUTH = Path(
    r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve"
    r"\.opencode-private\data\opencode\auth.json"
)
sys.path.insert(0, str(SKILLOPT))

from skillopt.model import minimax_backend  # noqa: E402


auth = json.loads(AUTH.read_text(encoding="utf-8-sig"))
key = str((auth.get("minimax-cn-coding-plan") or {}).get("key") or "").strip()
if not key:
    raise SystemExit("Isolated MiniMax Coding Plan credential is missing")

minimax_backend.configure_minimax_chat(
    base_url="https://api.minimaxi.com/anthropic/v1",
    api_key=key,
    temperature=0.2,
    timeout_seconds=120,
    max_tokens=64,
    enable_thinking=False,
)
minimax_backend.set_optimizer_deployment("MiniMax-M2.7")
minimax_backend.set_target_deployment("MiniMax-M2.7")
optimizer_text, optimizer_usage = minimax_backend.chat_optimizer(
    "Reply with exactly READY.",
    "Optimizer preflight.",
    max_completion_tokens=16,
    retries=1,
    stage="merge_optimizer_preflight",
    timeout=120,
)
target_text, target_usage = minimax_backend.chat_target(
    "Reply with exactly READY.",
    "Target preflight.",
    max_completion_tokens=16,
    retries=1,
    stage="merge_target_preflight",
    timeout=120,
)
result = {
    "passed": bool(optimizer_text.strip()) and bool(target_text.strip()),
    "backend": "minimax_chat",
    "model": "MiniMax-M2.7",
    "baseUrl": "https://api.minimaxi.com/anthropic/v1",
    "credentialSource": str(AUTH),
    "credentialPersisted": False,
    "optimizerResponseNonEmpty": bool(optimizer_text.strip()),
    "targetResponseNonEmpty": bool(target_text.strip()),
    "optimizerUsage": optimizer_usage,
    "targetUsage": target_usage,
}
out = Path(__file__).with_name("spreadsheetbench-minimax27-preflight-result.json")
out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False))
if not result["passed"]:
    raise SystemExit(1)
