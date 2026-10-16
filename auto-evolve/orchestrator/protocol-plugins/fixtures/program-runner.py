"""Trusted test harness. A workspace is not an OS security sandbox."""
import json
import os
import sys
import time

with open(sys.argv[1], encoding="utf-8-sig") as handle:
    payload = json.load(handle)
with open(payload["candidate"][0]["path"], encoding="utf-8-sig") as handle:
    source = handle.read()
with open(payload["materials"][0]["path"], encoding="utf-8-sig") as handle:
    cases = json.load(handle)
namespace = {}
exec(compile(source, "candidate.py", "exec"), namespace)
started = time.perf_counter_ns()
answers = [namespace["solve"](case) for case in cases]
elapsed_ns = time.perf_counter_ns() - started
print(json.dumps({"answers": answers, "elapsed_ns": elapsed_ns,
                  "secret_inherited": "AEV_EXECUTOR_TEST_SECRET" in os.environ,
                  "input_keys": sorted(payload), "cwd": os.getcwd()}))
