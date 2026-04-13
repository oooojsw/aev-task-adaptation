<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->

# Smoke Expert Workspace

Status: synthesized

## Purpose

Teach a blank agent to read the source token from `materials/source.txt` and produce `deployment/outputs/final.txt` containing that token in one uninterrupted session.

## Output Contract

- File path: `deployment/outputs/final.txt`
- File content: exactly the token value from `materials/source.txt` (no prefix, no extra whitespace)
- Token format in source: `source token: <value>`

## Execution Checklist

1. **Read source material**
   - Path: `materials/source.txt`
   - Extract the token value after `source token: ` prefix
   - Token example: `smoke-ok-20260413`

2. **Create output directory**
   - Ensure `deployment/outputs/` exists
   - Create if missing

3. **Write final.txt**
   - Path: `deployment/outputs/final.txt`
   - Content: only the token value (no trailing newline required)
   - Verify write succeeded

4. **Verify output**
   - Read `deployment/outputs/final.txt`
   - Confirm content matches token from source

## Path References

| Role            | Path                           |
| --------------- | ------------------------------ |
| Source material | `materials/source.txt`         |
| Output target   | `deployment/outputs/final.txt` |

## Operational Rules

- Do not add prefixes, labels, or extra text to the output
- The token is the entire content of final.txt
- Paths are relative to the task pack root (`campaign-smoke/`)
- Blank agent should complete this in one uninterrupted session

## Cross-Round Failure Lessons

- Before execution, read `lessons/failure_lessons.md` and apply the resolved failure-path guidance there.
