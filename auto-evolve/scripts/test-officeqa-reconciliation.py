import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("reconcile-officeqa-exemptions.ts")


class ReconciliationTests(unittest.TestCase):
    def test_revocation_preserves_evidence_and_other_success(self):
        # 隔离夹具验证撤销范围、备份和重复执行，保护真实运行账本。
        with tempfile.TemporaryDirectory(prefix="officeqa-audit-") as directory:
            root = Path(directory)

            def write(relative, data):
                file = root / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(json.dumps(data), encoding="utf-8")
                return file

            reward = root / "reward.py"
            reward.write_text("def score_answer(a, b, t):\n    return float(a == b)\n", encoding="utf-8")
            rows, tasks, originals = [], {}, {}
            for uid, candidate in (("CASE001", "DATA UNAVAILABLE"), ("CASE002", "5.432")):
                campaign = root / uid
                answer = campaign / "blank/sandbox/workspace/answer.txt"
                answer.parent.mkdir(parents=True)
                answer.write_text(candidate, encoding="utf-8")
                expected = campaign / "expected.txt"
                expected.write_text("5.432", encoding="utf-8")
                acceptance = write(f"{uid}/acceptance.json", {"passed": True, "blankEvalRunDir": str(campaign / "blank")})
                write(f"{uid}/blank/validators/officeqa-answer-validate/result.private.json", {
                    "raw": {"parsed": {"method": "data-unavailable-blocked" if uid == "CASE001" else "officeqa-reward"},
                            "command": ["python", "old.py", "--answer-path", str(expected), "--candidate", str(answer),
                                        "--reward", str(reward), "--tolerance", "0.01"]}})
                write(f"{uid}/campaign.json", {"id": uid, "status": "verified_success",
                    "lastFinalAcceptancePassed": True, "lastFinalAcceptanceResultPath": str(acceptance),
                    "reuse": {"allowed": True}})
                rows.append({"id": uid, "status": "verified_success", "campaignDir": str(campaign), "verified": True})
                tasks[uid] = {"status": "verified_success", "activeCampaignDir": str(campaign),
                    "activeAttemptID": "attempt-001", "attempts": [{"attemptID": "attempt-001", "status": "verified_success"}]}
                originals[answer] = answer.read_bytes()
                originals[acceptance] = acceptance.read_bytes()
            originals[root / "CASE002/campaign.json"] = (root / "CASE002/campaign.json").read_bytes()
            write("orchestrator-state.json", {"phase": "completed", "trainIDs": list(tasks), "trainResults": rows})
            write("task-ledger.json", {"tasks": tasks})
            write("final-report.json", {"trainVerified": 2})
            write("verified-training.json", rows)
            write("train-queue-results.json", rows)
            write("train-queue-summary.json", {"verified": 2, "failed": 0})
            (root / "scorecard.md").write_text("verified_success: **2**\nother terminal states: **0**\n| `CASE001` | `verified_success` |\n", encoding="utf-8")
            bun = shutil.which("bun.exe") or shutil.which("bun")
            command = [bun, "run", str(SCRIPT), "--run", str(root), "--apply"]
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=60,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertEqual(result.returncode, 0, result.stderr)
            outcome = json.loads(result.stdout)
            self.assertEqual(outcome["rejected"], ["CASE001"])
            self.assertEqual(outcome["passed"], 1)
            read = lambda name: json.loads((root / name).read_text(encoding="utf-8"))
            self.assertEqual(read("task-ledger.json")["tasks"]["CASE001"]["status"], "failed")
            self.assertEqual(read("CASE001/campaign.json")["lastFinalAcceptancePassed"], False)
            self.assertEqual(read("final-report.json")["trainVerified"], 1)
            self.assertEqual([x["id"] for x in read("verified-training.json")], ["CASE002"])
            self.assertEqual(read("train-queue-summary.json")["verified"], 1)
            for file, content in originals.items():
                self.assertEqual(file.read_bytes(), content)
            backups = json.loads(Path(outcome["auditPath"]).with_name("backups.json").read_text(encoding="utf-8"))
            self.assertEqual(len(backups), 8)
            for entry in backups:
                self.assertTrue(Path(entry["backup"]).exists())
            again = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=60,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertFalse(json.loads(again.stdout)["applied"])


if __name__ == "__main__":
    unittest.main()
