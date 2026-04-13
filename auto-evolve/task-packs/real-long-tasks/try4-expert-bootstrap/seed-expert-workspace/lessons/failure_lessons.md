<!-- auto-evolve-role: failure_lessons -->
# Cross-Round Failure Lessons

Status: seed lessons imported from pre-campaign failed runs

## Purpose

- These lessons come from failed deployment paths that already happened before the campaign controller took over.
- Future learning rounds should keep re-reading these lessons instead of rediscovering the same failure blindly.
- Blank deployment runs should also read these lessons, because they capture the highest-value known mistakes.

## Stable Failed Paths Already Observed

- The real acceptance surface is `deployment/outputs`, not only the intermediate expert-workspace artifacts.
- Placeholder handling must target the actual double-byte placeholder markers `U+3010 / U+3011`.
- Internal placeholders that map to workbook data must not remain in the generated documents.
- Numeric consistency matters; low numeric recall against the expert documents is a real failure even when files exist.
- Do not claim success before rerunning the blank-agent deployment path or equivalent self-checks against the actual deployment outputs.

## High-Value Corrections Learned So Far

- Re-run generation when `deployment/outputs` still contains unresolved internal placeholders, even if an upstream unit claimed success.
- Distinguish internal placeholders from external-required placeholders instead of treating all unresolved placeholders as equivalent.
- Keep the deployment expert surface path correct. A previous failed path came from the deployment spec reading the wrong learned workspace surface.
- Blank deployment should read only the formal `expert-workspace` entry points, not a stale alternate surface such as `experience-workspace`.
- Treat blank-agent deployment as the authoritative end-to-end check; local generation success alone is not enough.
- Workspace layout passing is not enough. A deployment path still fails if the generated Word outputs keep placeholder markers or lose required filled data consistency.

## Known Historical Failure Signatures

- `placeholder markers remain in deployment outputs`
- `numeric recall below threshold`
- `wrong deployment expert surface path`
- `deployment read the wrong expert surface`
- `workspace layout passed but deployment outputs still failed`
- `success claimed before deployment re-validation`
