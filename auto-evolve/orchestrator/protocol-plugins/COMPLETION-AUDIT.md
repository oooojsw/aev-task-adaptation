# Compatibility goal completion audit

Checkpoint: 2026-10-12. Goal remains unproven, not complete. This matrix records
evidence scope rather than equating passing tests with universal compatibility.
Authoritative goal: E:/project/AEV-RuleArena-NBA/aev-single-turn/ACCEPTANCE-PLUGIN-COMPATIBILITY-GOALS-20261011.md.

| Goal requirement | Current evidence | Remaining boundary |
| --- | --- | --- |
| Explicit project, protocol, runtime separation | project-pack.test.ts, pipeline-config.test.ts, training.test.ts | Live deployment not certified |
| Freeze choices before work and resume | index.test.ts, entry.test.ts, project-batch.test.ts | Interrupted backend calls stop for inspection, not automatic resend |
| Preserve learning roles and revision loop | campaign-lifecycle.test.ts; baseline/current legacy-campaign.test.ts covers pass, rejection, two-round replanning/revision and zero-call terminal resume | Interrupted nonterminal recovery and full live host remain unverified |
| Train-side tools independent of acceptance | campaign-lifecycle.test.ts, http-chat.test.ts, tool-session.test.ts | Arbitrary tool permission enforcement requires broader audit |
| Arbitrary Skill entries and materials | candidate.test.ts, project-pack.test.ts | New binary kinds need declared adapters; no claim all types supported |
| Skill-only versus executed claims | runtime.test.ts, compiler tests | Skill-only success is not task success or generalization proof |
| Script and independent model judge | script-checker.test.ts, model-judge.test.ts | Live model/provider behavior not tested |
| Failure objects drive feedback | training-feedback.test.ts, campaign-lifecycle.test.ts | Broad filesystem read permissions remain open |
| Preserve selected merge and lineage | merge-strategy.test.ts, merge-stage.test.ts, project-batch.test.ts | Flat/hierarchical declared-entry adapters supported; other merge adapters must not be aliased |
| Optional replay, depth and repair mode | project-batch.test.ts; disabled replay, selected rewrite, final replay and mismatch guards | Does not certify every legacy repair configuration |
| Held-out cannot repair | project-batch.test.ts scoring-fault/held-out rejection tests | Live task score not measured |
| Scoring switch reuses actual answer | cache.test.ts, nba-protocol.test.ts | Version/config changes are intentional new scoring identities |
| Old defaults, requests and outcomes | Prompt/coordinator/merger/fanout checks plus legacy-campaign.test.ts compares requests, blank specs and terminal states/resume using each version's dependency sources | Fixed receipts, identified source task and seeded package; not every old configuration or interrupted nonterminal recovery |
| NBA outside new core | projects/nba/pack.test.ts, actual Campaign batch, project-boundary.test.ts inventories tracked core and hashes | Pre-existing blank-eval/single-turn.ts NBA tag stays byte-identical to baseline; lexical inventory is not universal semantic proof |
| Every call resource/error evidence | attempt-accounting.test.ts, opencode-driver.test.ts | Training/merge/repair author usage/time and pre-receipt errors not fully consolidated |
| Safe recovery | batch-recovery.test.ts plus exclusive claims/cache tests | Supervisor unlock never authorizes incomplete call resend |
| Backup, Git and rollback | E:/project/AEV-protocol-plugins-20261011 baseline manifest and Git worktree | Final release and documented rollback acceptance remain open |

## Test method

Tests use synthetic public/private inputs, fixed model replies, real localhost
HTTP transport and Python scorers. No paid provider or production model requests.
Current production source is not deployed. A CLI build is not strict TypeScript
checking. The full suite command from this directory is:

```powershell
bun test . ../../projects/nba/pack.test.ts
```

Do not remove remaining requirements to declare completion. Final acceptance must
inspect actual evidence for each row and preserve historical artifacts unchanged.
