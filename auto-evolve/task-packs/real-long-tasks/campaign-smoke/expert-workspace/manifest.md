<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->

# Smoke Expert Workspace

Status: operational_ready

## Purpose

This workspace teaches a blank agent to read the source material and produce a final text output containing the extracted token.

## Deployment Contract

A blank agent receiving this workspace will:

1. Have access only to `materials/source.txt` (source-artifact)
2. Have access only to this workspace directory (expert-workspace)
3. Must produce `deployment/outputs/final.txt` (target-artifact)
4. Must NOT receive human assistance during the run

## Source Material Specification

**File**: `materials/source.txt`
**Expected format**: `source token: <value>`
**Example**: `source token: smoke-ok-20260413`
**Extracted token value**: `smoke-ok-20260413`

## Blank Agent Execution Checklist

1. **Read phase**
   - Read `materials/source.txt`
   - Locate the line containing `source token:`
   - Extract the token value after the colon prefix

2. **Write phase**
   - Create directory path `deployment/outputs/` if not exists
   - Write a text file at `deployment/outputs/final.txt`
   - File content must be exactly the extracted token value (no extra whitespace)

3. **Self-check phase**
   - Verify `deployment/outputs/final.txt` exists
   - Verify file content equals the extracted token

## Validators

- **contains-token**: Final output file contains token `smoke-ok-20260413`

## File Locations

| Role                    | Path                           |
| ----------------------- | ------------------------------ |
| Source material         | `materials/source.txt`         |
| Expert workspace (this) | `expert-workspace/`            |
| Deployment target       | `deployment/outputs/final.txt` |

## Token Extraction Logic

```
line = read_line("materials/source.txt")
if line.starts_with("source token:"):
    token = line.split(":", 1)[1].strip()
    write("deployment/outputs/final.txt", token)
```

## Path Resolution

All paths are relative to the campaign-smoke task pack root:

- Task pack root: `task-packs/real-long-tasks/campaign-smoke/`
- Workspace is at: `expert-workspace/`
- Source is at: `materials/source.txt`
- Target is at: `deployment/outputs/final.txt`

## Cross-Round Failure Lessons

- Before execution, read `lessons/failure_lessons.md` and apply the resolved failure-path guidance there.
