# Method: Parallel Batch 5 Add Only

Status: active V1 batch method

## Purpose

- This method is the first V1 batch-learning kernel for auto-evolve.
- It runs a micro-batch of five cases in parallel light shards, then performs one additive maintenance transaction for the whole batch.
- It is meant to strengthen local learning throughput without letting multiple maintainers write into the canonical workspace at the same time.

## Notes

- Prompt instructions live under `prompts/`.
- Case shards only solve, judge, and produce learning packets.
- The actual workspace write still happens once per batch through a single batch maintainer.
- This method reuses the add-only maintenance style and keeps batch writes conservative.
