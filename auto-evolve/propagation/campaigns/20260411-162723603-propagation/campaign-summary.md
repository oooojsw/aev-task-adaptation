# Propagation Campaign Summary

- campaign: 20260411-162723603-propagation
- propagation method: add-only
- propagation method doc: C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\methods\add-only\METHOD.md
- maintenance method: add-only
- source ref: canonical
- source commit: 20260411-155514814-268c264b90bf
- candidate commit: 20260411-163330382-268c264b90bf
- branch: add-only-add-only-20260411-162723603-propagation
- branch head: 20260411-163330382-268c264b90bf
- baseline dir: C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\propagation\workspaces\add-only-add-only-20260411-162723603-propagation\runs\20260411-162723637-baseline

## Workspace Planes

- tracked documents: 5
- tracked helper assets: 0
- runtime sidecar files preserved locally and excluded from candidate commit: 0
- Candidate commits in the third layer still snapshot only the tracked experience plane.
- Runtime sidecar files remain local to the branch workspace and do not participate in commit diff, merge, rollback, or promotion.

## Train

- passed: 0/1
- accepted refines: 0
- rejected refines: 0

## Test

- passed: 1/1
- accepted refines: 0
- rejected refines: 0

## Current Scope

- This initial third-layer implementation creates one experimental branch, runs one delegated second-layer method on that branch, and records the resulting candidate commit.
- It does not yet perform merge, promotion, or multi-branch comparison.
