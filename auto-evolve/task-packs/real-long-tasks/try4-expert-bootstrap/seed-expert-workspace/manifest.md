<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->
# try4 Expert Workspace Seed

Status: bootstrap seed

## Purpose

This seed exists only to describe the required end-state of the learned expert workspace.

The live target workspace is `../expert-workspace`.

## Required final shape

The learned workspace should grow into a formal expert surface that includes, when useful:

- core rules
- output contract
- execution checklist
- exception handling
- summarized failure lessons
- tool guidance
- task routing hints

The formal surface may describe itself with inline markers, a root-level `surface_contract.json`, or a mixed mode. Do not assume every document must carry inline markers if the contract already declares the role map.

## Deployment requirement

The final workspace must be strong enough for a blank agent to complete the deployment task in one uninterrupted session using only:

- the formal workspace,
- the registered capability assets,
- the declared task materials,
- the task-specific scope in `../materials/human-guidance.md`.

## Cross-Round Lessons

- Before writing or validating any generated output, also read `lessons/failure_lessons.md`.
- That file records failed paths already paid for by previous rounds and should be treated as mandatory guidance, not optional notes.
