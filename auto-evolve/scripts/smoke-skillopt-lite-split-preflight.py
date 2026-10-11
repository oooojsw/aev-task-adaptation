"""Offline checks for the merge-as-lite OfficeQA split guard."""
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path


module_path = Path(__file__).with_name("skillopt-lite-merge-bridge.py")
spec = importlib.util.spec_from_file_location("lite_merge_bridge", module_path)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="aev-lite-split-") as folder:
    root = Path(folder)
    for split, uid in (("train", "UID0001"), ("val", "UID0002"), ("test", "UID0003")):
        target = root / split / "items.json"
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps([{"id": uid}]), encoding="utf-8")

    try:
        module.verify_officeqa_split(root, [{"id": "UID0001"}])
    except RuntimeError as error:
        assert "lacks question or answer" in str(error)
    else:
        raise AssertionError("id-only split was accepted")

    for split in ("train", "val", "test"):
        target = root / split / "items.json"
        rows = json.loads(target.read_text(encoding="utf-8"))
        rows[0].update({"question": "Question?", "ground_truth": "Answer", "source_files": "document.txt"})
        target.write_text(json.dumps(rows), encoding="utf-8")
    assert module.verify_officeqa_split(root, [{"id": "UID0001"}]) == {
        "train": 1,
        "val": 1,
        "test": 1,
    }
    materials = root / "materials"
    materials.mkdir()
    try:
        module.verify_officeqa_split(root, [{"id": "UID0001"}], materials)
    except RuntimeError as error:
        assert "missing source document" in str(error)
    else:
        raise AssertionError("missing OfficeQA material was accepted")
    (materials / "document.txt").write_text("evidence", encoding="utf-8")
    assert module.verify_officeqa_split(root, [{"id": "UID0001"}], materials)["train"] == 1

    try:
        module.verify_officeqa_split(root, [{"id": "UID0003"}])
    except RuntimeError as error:
        assert "members of the train split" in str(error)
    else:
        raise AssertionError("test-set source Skill was accepted")

print("merge-as-lite split preflight: ok")

with tempfile.TemporaryDirectory(prefix="aev-lite-gate-") as folder:
    eval_root = Path(folder)
    (eval_root / "eval_summary.json").write_text(
        json.dumps({"n_items": 1, "hard": 1.0, "soft": 1.0}), encoding="utf-8"
    )
    (eval_root / "results.jsonl").write_text(json.dumps({"id": "UID0001"}) + "\n", encoding="utf-8")
    assert module.score(eval_root, "hard", {"UID0001"})[0] == 1.0
    try:
        module.score(eval_root, "hard", {"UID0001", "UID0002"})
    except RuntimeError as error:
        assert "incomplete" in str(error)
    else:
        raise AssertionError("partial validation summary was accepted")
