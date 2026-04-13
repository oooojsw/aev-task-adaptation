<!-- auto-evolve-role: change_log -->
# 20260413 Expert Surface Contract Implementation

## Goal

Replace the current hard-coded "workspace layout" truth with a higher-level expert surface contract model:

- keep deployment as the highest capability gate
- downgrade file-shape rules into governed surface validation
- allow central declaration of entry / change log / document roles / helper roots / runtime sidecar roots
- stop requiring every document to embed inline role markers as the only valid form

## Scope

1. Add `surface_contract.json` support to the experience workspace model.
2. Add validation profiles:
   - `operational`
   - `governed`
3. Keep legacy inline markers working for backward compatibility.
4. Teach long-task expert-surface generation prompts about the contract path and profile idea.
5. Update the validator script and acceptance registry wording so this is framed as surface validation, not absolute truth.
6. Add a generic smoke test:
   - legacy marker-driven workspace still passes governed validation
   - contract-driven workspace without per-file markers passes operational validation

## Non-Goals

- Do not add task-specific Word or Excel execution logic.
- Do not change deployment acceptance semantics.
- Do not touch monitor-server.
- Do not force every task pack to use a new contract file immediately.

## Expected Outcome

The system will still support a canonical managed workspace, but the validator will no longer assume that "every file must look like our exact Markdown schema" is the only valid expert experience form.
