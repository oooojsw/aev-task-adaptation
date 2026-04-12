# Flow: Parallel Batch 5 Add Only

## Local Learning Recipe

- execution strategy: parallel-batch-5-light-shard
- packetization policy: batch-5-aggregate
- maintenance module: add-only
- acceptance policy: add-only-batch-conservative-guard

## Notes

- Each shard only runs solve + pre-judge + learning-packet extraction.
- One batch maintainer reads the aggregated batch learning packet and writes one additive update.
