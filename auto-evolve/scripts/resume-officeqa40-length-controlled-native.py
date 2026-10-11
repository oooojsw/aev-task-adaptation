"""Resume only the interrupted native Opt tail in its original E-drive run."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def write_status(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--native-root", required=True)
    parser.add_argument("--skillopt-root", required=True)
    parser.add_argument("--key-file", required=True)
    args = parser.parse_args()

    native_root = Path(args.native_root).resolve()
    skillopt_root = Path(args.skillopt_root).resolve()
    key_file = Path(args.key_file).resolve()
    status_path = native_root / "native-resume-controller.json"
    if not (native_root / "runtime_state.json").is_file():
        raise RuntimeError(f"Missing resumable native runtime state: {native_root}")
    if not (skillopt_root / "skillopt").is_dir():
        raise RuntimeError(f"Invalid isolated SkillOpt checkout: {skillopt_root}")
    key = next((line.strip() for line in key_file.read_text(encoding="utf-8-sig").splitlines() if line.strip()), "")
    if len(key) < 16:
        raise RuntimeError("MiniMax key file has no usable key")

    cfg = json.loads((native_root / "config.json").read_text(encoding="utf-8-sig"))
    if cfg.get("skill_max_bytes") != 5768 or cfg.get("target_model") != "MiniMax-M2.7":
        raise RuntimeError("Refusing to resume a run whose length-control or MiniMax identity differs")
    if not cfg.get("eval_test"):
        raise RuntimeError("Refusing to resume without the originally fixed test172 evaluation")

    write_status(status_path, {
        "status": "running",
        "nativeRoot": str(native_root),
        "resumeFrom": json.loads((native_root / "runtime_state.json").read_text(encoding="utf-8-sig")).get("last_completed_step"),
        "purpose": "Resume only the unfinished native Opt step and fixed MiniMax test172 after the outer bridge process disappeared.",
    })
    sys.path.insert(0, str(skillopt_root))
    os.chdir(skillopt_root)
    os.environ["MINIMAX_API_KEY"] = key
    from scripts.train import get_adapter
    from skillopt.engine.trainer import ReflACTTrainer
    from skillopt.model import configure_minimax_chat, set_optimizer_backend, set_optimizer_deployment

    # 保持原训练配置，只恢复未落盘的最后一步及其固定测试。
    configure_minimax_chat(base_url=str(cfg["minimax_base_url"]), api_key=key)
    set_optimizer_backend("minimax_chat")
    set_optimizer_deployment("MiniMax-M2.7")
    summary = ReflACTTrainer(cfg, get_adapter(cfg)).train()
    write_status(status_path, {"status": "completed", "summaryPath": str(native_root / "summary.json")})
    print(json.dumps({"ok": True, "summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        native_arg = ""
        for index, value in enumerate(sys.argv[:-1]):
            if value == "--native-root":
                native_arg = sys.argv[index + 1]
                break
        if native_arg:
            try:
                write_status(Path(native_arg).resolve() / "native-resume-controller.json", {"status": "failed", "error": str(exc)})
            except Exception:
                pass
        raise
