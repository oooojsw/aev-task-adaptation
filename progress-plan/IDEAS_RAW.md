# Raw Ideas

This file preserves the user's original intent and raw direction notes in a compact, direct form.

## Core Goal

Build a system that can:

- automatically extract expert experience into one file or one file system
- allow that knowledge pack to include both documents and scripts
- let a completely fresh agent follow that knowledge and finish all required operations from zero
- generalize strongly to new case materials

## User Direction Notes

Raw intent summary:

- the first round should generate the expert experience file itself
- later rounds should use the current expert experience to solve cases
- after failure, the system should summarize failure experience back into the expert knowledge
- future refinement may no longer follow the current "backprop" method
- many different refinement / backprop ideas will need to be tested later
- those tests should support different AI sessions and parallel execution
- multiple experiments may share most expert knowledge and differ only in small parts
- if possible, expert knowledge should be managed with a git-tree-like structure
- the rules themselves should stay in Markdown documents, not be buried inside TypeScript logic
- scripts are still valuable, but scripts should consume knowledge documents rather than becoming the hidden knowledge source of truth
- the `scripts/` layer should ideally feel like a local skills library
- a script capability should be describable by Markdown plus YAML frontmatter
- if possible, a valid skill-like folder should become usable just by copying it into the scripts area

## Important Strategic Intent

The user does not only want:

- a single loop
- a single prompt
- a single expert_rules file

The user ultimately wants:

- a knowledge extraction system
- a reusable expert knowledge pack
- a flexible refinement research platform
- support for multiple concurrent experiments
- a knowledge representation that stays human-readable and auditable
- efficient branching of similar expert states for experiment comparison

## Current Interpretation Of "Backprop"

In this project, "backprop" currently means:

- use the failure from one solve attempt
- construct a refinement prompt
- update the expert knowledge
- retry with the updated expert knowledge

This is currently prompt-driven refinement, not mathematical gradient backpropagation.

## Future Backprop Directions To Leave Open

Future variants may include:

- stronger use of action trace
- stronger use of tool-path analysis
- rule-specific correction prompts
- file-structured lesson writing instead of one-file editing
- parallel candidate refinements
- choosing the best refinement branch by evaluation score
- Git-tree-backed knowledge branching for concurrent experiments
- strategy-specific prompt variants that modify only parts of the knowledge pack

## Knowledge Representation Preferences

The user's current preference is:

- rules and expert knowledge should live in `.md` files
- these Markdown knowledge files should be the source of truth
- helper scripts may assemble or consume these files
- helper scripts should not become the hidden place where the real rules are stored

## Why `scripts/` Still Matters

The user explicitly likes the `scripts/` layer because it preserves:

- designed helper scripts
- reusable tooling
- execution-time helpers for the model

The intended split is:

- Markdown files = knowledge / rules / contracts / lessons
- `scripts/` = executable capability layer built around those documents

The preferred future shape is:

- `scripts/` keeps helper code and tool wrappers
- each reusable script capability has a Markdown descriptor with YAML frontmatter
- ideally this descriptor is compatible with OpenCode's existing `SKILL.md` loading pattern
- copying a compatible folder into `auto-evolve/scripts/` should be enough to make it available

## Reminder For Future Work

Whenever a future design choice conflicts with the final objective, optimize for this:

- can this help a new agent succeed from zero using only the produced knowledge pack?
