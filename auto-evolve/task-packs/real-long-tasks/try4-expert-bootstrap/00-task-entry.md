# try4 Expert Bootstrap

This task pack exists to learn a formal expert experience workspace from real materials.

## Global Objective

- Learn a reusable expert experience workspace from declared task materials.
- The learned workspace must enable a blank agent to finish deployment in one uninterrupted session using only:
  - the formal expert workspace
  - the registered capability assets
  - the declared task materials
  - the scope/rules defined in `materials/human-guidance.md`

## What This Task Is Not

- It is not a direct one-off document-generation task.
- It is not a prompt-only summary task.
- It is not allowed to hardcode a brittle task-specific route into the platform code.

## Required End State

Produce a tracked expert workspace under `./expert-workspace` that becomes valid as a formal expert surface and passes blank-agent deployment acceptance.

## Constraints

- Keep the learned experience abstract and operational.
- Prefer stable rules, checks, contracts, and tool guidance over case-only narration.
- If there are special cases, isolate them as exceptions instead of polluting core rules.
- The formal expert surface may declare itself through inline markers, a root-level `surface_contract.json`, or a mixed mode.
- Do not use runtime-state, candidate packages, or hidden maintenance traces as final deployment dependencies.
