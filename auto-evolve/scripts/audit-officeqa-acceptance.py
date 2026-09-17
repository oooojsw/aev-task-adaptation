"""Offline replay of the recorded final answers; never calls a model or edits old evidence."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    args = parser.parse_args()
    run = Path(args.run).resolve()
    script = Path(__file__).with_name("validate-officeqa-answer.py").resolve()
    state = read_json(run / "orchestrator-state.json")
    rows = []
    # 重判只读隔离考场原件，报告与历史验收结果分开保存。
    for item in state["trainResults"]:
        if item["status"] != "verified_success":
            continue
        row = {"id": item["id"], "campaignDir": item["campaignDir"]}
        try:
            campaign = read_json(Path(item["campaignDir"]) / "campaign.json")
            acceptance_path = campaign["lastFinalAcceptanceResultPath"]
            acceptance = read_json(acceptance_path)
            validator = Path(acceptance["blankEvalRunDir"]) / "validators" / "officeqa-answer-validate"
            original = read_json(validator / "result.private.json")
            command = original["raw"]["command"]
            flags = ["--answer-path", "--candidate", "--reward", "--tolerance"]
            values = {flag: command[command.index(flag) + 1] for flag in flags}
            sandbox = (Path(acceptance["blankEvalRunDir"]) / "sandbox").resolve()
            candidate = Path(values["--candidate"]).resolve()
            if not candidate.is_relative_to(sandbox):
                raise ValueError("Candidate is outside the recorded sandbox")
            cmd = [sys.executable, str(script)]
            for flag in flags:
                cmd.extend([flag, values[flag]])
            process = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                                     timeout=120, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            result = json.loads(process.stdout)
            row.update({"oldMethod": original["raw"]["parsed"].get("method"),
                        "acceptancePath": acceptance_path, "candidatePath": str(candidate),
                        "candidateSha256": hashlib.sha256(candidate.read_bytes()).hexdigest(),
                        "exitCode": process.returncode, "result": result,
                        "passed": process.returncode == 0 and result.get("passed") is True})
        except Exception as error:
            row.update({"passed": False, "auditError": str(error)})
        rows.append(row)
    report = {"createdAt": datetime.now(timezone.utc).isoformat(), "runDir": str(run),
              "validatorSha256": hashlib.sha256(script.read_bytes()).hexdigest(),
              "reviewed": len(rows), "passed": sum(r["passed"] for r in rows),
              "auditErrors": sum("auditError" in r for r in rows), "rows": rows}
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
