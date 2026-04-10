---
name: exact-output
description: Summarize output-comparison evidence for judge runs.
---

# When To Use

Use this skill when the judge needs a compact structured summary of expected vs actual output comparison.

# Script

- scripts/run.py

# Expected Input

Provide an input JSON path and an output JSON path:

- python scripts/run.py <input-json> <output-json>
