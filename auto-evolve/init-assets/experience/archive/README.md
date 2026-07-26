# Experience Archive

This directory stores managed pre-reset snapshots of the tracked expert experience workspace.

- Every reset writes one new history entry and never overwrites prior history.
- `latest/` mirrors only the newest archived version for quick restore.
- `history/` stores the durable archive lineage.
- `index.json` records the archive list.
- Only the tracked expert-experience plane is archived here.
- Runtime sidecars such as `.opencode/` are excluded from the archive snapshot.
- The active workspace is reset to the minimal legal seed after archiving.
