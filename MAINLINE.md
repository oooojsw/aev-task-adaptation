# OpenCode Auto-Evolve Mainline

This repository is the cleaned full-project development mainline for the local project previously kept at:

```text
C:\Users\ZhuanZ\Desktop\opencode re\opencode latest
```

It intentionally keeps the full project source shape, including OpenCode changes and the Auto-Evolve system, while removing the original upstream OpenCode commit ancestry.

## History Shape

- Commit 1 is a synthetic source baseline matching the OpenCode tree that was originally cloned locally on 2026-04-02.
- The following commits replay the local Auto-Evolve/OpenCode development chain in original order.
- Author names, author emails, dates, and commit messages are preserved as far as Git replay allows.
- Original upstream `sst/opencode` history is not part of this repository. Keep upstream license and attribution files intact.

## What Belongs Here

- OpenCode source changes.
- Auto-Evolve source code, orchestration code, validators, prompts, adapters, configs, and smoke tests.
- Dataset descriptors, split files, task specs, and lightweight task instructions when they are needed to run code.
- README, AGENTS, progress records, architecture notes, and migration notes.

## What Must Not Be Committed

- `runtime-state`, run logs, isolated OpenCode session caches, SQLite state, model caches, and temporary folders.
- Raw benchmark materials: PDFs, Office files, videos, images, extracted page text, OCR dumps, and parsed corpora.
- Private answers, ground truth files, hidden validator payloads, cookies, API keys, browser tokens, and auth exports.
- Agent workspaces, generated answers, task outputs, deployment work directories, and one-off debug artifacts.
- `node_modules`, build outputs, compiled binaries, and package-manager caches.

## Operating Rule

The local working project can still contain runtime state and datasets. This mainline is the clean code/history carrier. Before pushing, always run a status and artifact audit so only code and record files enter Git.
