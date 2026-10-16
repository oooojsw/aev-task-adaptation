import json
import sys

with open(sys.argv[1], encoding="utf-8-sig") as handle:
    payload = json.load(handle)
with open(payload["candidate"][0]["path"], encoding="utf-8-sig") as handle:
    product = json.load(handle)
with open(payload["privateInputs"][0]["path"], encoding="utf-8-sig") as handle:
    expected = json.load(handle)
correct = product.get("answers") == expected
valid_timing = isinstance(product.get("elapsed_ns"), int) and product["elapsed_ns"] >= 0
print(json.dumps({"status": "passed" if correct and valid_timing else "rejected",
                  "message": "Outputs and timing checked" if correct and valid_timing else "Incorrect program outputs or missing timing"}))
