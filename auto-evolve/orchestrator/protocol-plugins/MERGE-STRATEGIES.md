# Protocol merge strategy selection

Only opt-in protocol runs use this interface. Legacy merger behavior and files
remain unchanged. Omitting mergeStrategy preserves the existing flat protocol
merge. Selection belongs in the frozen pipeline configuration:

```json
{
  "schema": "aev.protocol-pipeline.v1",
  "mergeAuthor": {
    "model": "provider/model",
    "expectedModel": "provider/model",
    "timeoutMs": 60000,
    "maxInputBytes": 200000
  },
  "mergeStrategy": { "kind": "hierarchical", "groupSize": 2 }
}
```

Supported strategies:

- flat: one author invocation and explicit merge acceptance over all sources.
- hierarchical: consecutive groups in frozen source order; each group runs the
  same declared merge author and merge acceptance. Accepted group outputs enter
  the next layer until one output remains. A final singleton group is still
  explicitly merged and accepted; it is not silently promoted as a source.

Each layer preserves original train UIDs, author request/reply, candidate hashes,
and acceptance identity. Intermediate inputs are not labeled source-task passes.
This strategy does not add per-group source replay: replay/repair remains the
separately configured post-merge stage. No held-out feedback reaches authors.

groupSize must be an integer between 2 and 1000. Backend input budgets remain
per merge invocation; exceeding them stops rather than truncates. Failed or
incomplete groups stop downstream scheduling. Completed groups are verified and
reused on recovery; interrupted author calls do not resend automatically.

Changing/removing a frozen strategy or group size is blocked. Existing flat
directories cannot become hierarchical, nor the reverse. New development context
snapshots now include sourceUIDs; old development snapshots require inspection,
not silent migration. Production legacy snapshots are unaffected.

This is not an Opt/Lite adapter or long-task merge learning algorithm. Those
strategies must explicitly implement their contracts rather than be aliased to
hierarchical merging.
