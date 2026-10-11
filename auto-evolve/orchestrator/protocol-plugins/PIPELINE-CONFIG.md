# Explicit pipeline runtime configuration

Development-only integration; complete source/merge/replay/test acceptance is not
yet certified. No live model call is implied by this document.

The multi-instance CLI and benchmark accept `--protocol-run-config <absolute-json>`.
Project inputs and acceptance phases remain in the frozen source spec's
`protocolPlugins` entry; this file selects merge and optional repair authors only.
It does not replace the selected executor or judge.

```json
{
  "schema": "aev.protocol-pipeline.v1",
  "mergeAuthor": {
    "model": "your-provider/your-model",
    "expectedModel": "your-provider/actual-model",
    "timeoutMs": 600000,
    "maxInputBytes": 1000000
  },
  "repairAuthor": {
    "model": "your-provider/your-model",
    "expectedModel": "your-provider/actual-model",
    "timeoutMs": 600000,
    "maxInputBytes": 1000000,
    "mode": "append_only"
  }
}
```

Models above are placeholders, not verified model identities. Do not embed secrets.
If repairAuthor is absent, explicitly use `--repair-attempts 0`. Author timeout and
maxInputBytes are invocation limits, not output Skill length or total run token caps.
Existing round/concurrency/stage controls remain separate.

The configuration freezes before new training. Removing or changing it on recovery,
an incomplete claim, or an orphan snapshot blocks rather than rebuilding defaults.
No option means legacy behavior for legacy runs; a frozen protocol source cannot
silently use legacy merging. Benchmark currently supports this branch only with
the flat scripted merge adapter; other adapters reject before training rather than
changing the selected strategy. Supporting their protocol boundaries remains work.

Successful source harvesting binds actual final acceptance, copied declared entries
and receipt fingerprints. Merger author reads staged Skill entries, not private
answers or whole campaign roots. Source-only verification remains a Skill-check
claim; it is not promoted into a task-execution claim.

Completed merge recovery verifies author evidence, output and protocol verdict.
Interrupted author calls require inspection and are never automatically resent.
