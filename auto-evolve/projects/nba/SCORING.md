# Explicit NBA scoring modes

No existing protocol or historical result is migrated. Select one scorer path
and freeze its SHA-256 using script-json-checker settings.

| Script | Meaning |
| --- | --- |
| scorer.py | Existing local rule: parse the last Answer conclusion, case-insensitive; require operation/team for an illegal result. |
| official-scorer.py | Upstream rule: remove bold markers, then search the exact case-sensitive target string anywhere in the response. |

These are different protocols, not interchangeable scores. Upstream substring
matching may accept a quoted correct answer followed by an incorrect conclusion,
or Answer: Falsehood for a legal label. The official adapter intentionally retains
that behavior for reproduction; the local rule remains unchanged.

scoring-equivalence.py compares 22 fixed cases against only the pure scoring AST
from E:/project/RuleArena-upstream/nba/auto_test.py, pinned SHA-256
8a8677c36579dd945f978da8cd8eed264d5072cb719fa6f1e260ef9aceb2e29c.
It never imports or executes the upstream API runner. Six cases distinguish modes.
This verifies scoring equivalence only, not prompt/context/runtime equivalence.

Both adapters require an explicit product and a separate valid gold artifact.
Malformed labels or artifact fingerprints yield data_error, not an ordinary
Skill rejection. No task-specific numbers or NBA logic enter AEV core modules.
