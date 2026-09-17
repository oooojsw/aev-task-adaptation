import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("validate-officeqa-answer.py")


class OfficeQAValidatorTests(unittest.TestCase):
    # 用真实子进程验证输出与退出码，防止自报失败被计为成功。
    def invoke(self, expected, predicted, *, sidecar=None, score="0.0", tolerance="0.01"):
        with tempfile.TemporaryDirectory(prefix="officeqa-validator-") as directory:
            root = Path(directory)
            (root / "expected.txt").write_text(expected, encoding="utf-8-sig")
            (root / "answer.txt").write_text(predicted, encoding="utf-8-sig")
            if sidecar is not None:
                (root / "answer.json").write_text(sidecar, encoding="utf-8-sig")
            (root / "reward.py").write_text(
                f"def score_answer(*args):\n    return {score}\n", encoding="utf-8"
            )
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--answer-path", str(root / "expected.txt"),
                 "--candidate", str(root / "answer.txt"), "--reward", str(root / "reward.py"),
                 "--tolerance", tolerance],
                capture_output=True, text=True, encoding="utf-8", timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return result, json.loads(result.stdout) if result.stdout.strip() else None

    def assert_failure(self, result, payload):
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNotNone(payload)
        self.assertIs(payload["passed"], False)

    def test_unavailable_is_not_success(self):
        result, payload = self.invoke("4.321", "DATA UNAVAILABLE")
        self.assert_failure(result, payload)

    def test_blocked_sidecar_cannot_override_wrong_answer(self):
        for answer in ("0", "[0000, 0.00]", "[2031, 9.99]"):
            with self.subTest(answer=answer):
                result, payload = self.invoke(
                    "[2031, 1.25]", answer,
                    sidecar=json.dumps({"claimed_success": False, "blockers": ["OCR unavailable"]}),
                )
                self.assert_failure(result, payload)

    def test_self_claimed_success_cannot_override_wrong_answer(self):
        self.assert_failure(*self.invoke("4.321", "0", sidecar='{"claimed_success": true}'))

    def test_correct_answer_is_not_vetoed_by_stale_sidecar(self):
        result, payload = self.invoke("4.321", "4.321", score="1.0",
                                     sidecar='{"claimed_success": false, "blockers": ["old"]}')
        self.assertEqual(result.returncode, 0)
        self.assertIs(payload["passed"], True)

    def test_correct_structured_answer(self):
        result, payload = self.invoke("[2031, 1.25]", "[2031, 1.250]")
        self.assertEqual(result.returncode, 0)
        self.assertIs(payload["passed"], True)

    def test_structured_wrong_answer(self):
        self.assert_failure(*self.invoke("[2031, 1.25]", "[2031, 9.99]"))

    def test_partial_score_is_failure(self):
        self.assert_failure(*self.invoke("4.321", "4", score="0.5"))

    def test_invalid_scores_fail_closed(self):
        for score in ("float('nan')", "float('inf')", "-1", "2", "None", "'1'", "True"):
            with self.subTest(score=score):
                result, payload = self.invoke("4.321", "0", score=score)
                self.assert_failure(result, payload)
                self.assertEqual(payload["failureKind"], "validator_infrastructure")

    def test_empty_candidate_is_failure(self):
        self.assert_failure(*self.invoke("4.321", "", score="1.0"))

    def test_empty_reference_is_infrastructure_failure(self):
        result, payload = self.invoke("", "", score="1.0")
        self.assert_failure(result, payload)
        self.assertEqual(payload["failureKind"], "validator_infrastructure")

    def test_invalid_tolerance_is_rejected(self):
        for tolerance in ("nan", "inf", "-0.01"):
            with self.subTest(tolerance=tolerance):
                result, _ = self.invoke("4.321", "0", score="1.0", tolerance=tolerance)
                self.assertNotEqual(result.returncode, 0)

    def test_nonfinite_structured_numbers_are_not_equal(self):
        for number in ("Infinity", "-Infinity", "NaN"):
            with self.subTest(number=number):
                self.assert_failure(*self.invoke(f"[{number}]", f"[{number}]"))


if __name__ == "__main__":
    unittest.main()
