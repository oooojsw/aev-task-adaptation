---
name: tool-failures
description: Summarize tool-failure evidence for judge runs.
---

# When To Use

Use this skill when the judge needs a compact summary of failed tool calls.

# Script

- scripts/run.py

# Expected Input

Provide an input JSON path and an output JSON path:

- python scripts/run.py <input-json> <output-json>
