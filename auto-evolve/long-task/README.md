# Long-Task Workspace

This directory stores validator-driven long-task runs.

- `runs/`: one directory per long-task execution
- `archive/`: append-only archive index for all long-task runs
- `shadow-memory/`: isolated shadow-memory entries for long-task outcomes
- `candidates/`: future handoff area for canonical candidates

The long-task module is a first-layer sibling of the short-task module.
It is a generic learning framework centered on:

- goal contracts
- validator contracts
- capability contracts
- graph bootstrap and graph revision
- work-unit execution
- local retry and replan
- failure packets
- run-local scratch memory
- archive and shadow-memory handoff

Recommended entry command:

- `bun run auto-evolve/cli.ts run-long-task --spec auto-evolve/templates/long-task.example.json`
