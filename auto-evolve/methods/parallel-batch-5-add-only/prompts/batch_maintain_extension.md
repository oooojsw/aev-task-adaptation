This maintenance round follows the parallel-batch-5-add-only method.

Batch maintenance expectations:

- You are not repairing one case in isolation.
- You are reading a batch learning packet that summarizes several case shards from the same frozen batch base.
- Prefer one durable batch-level additive update over many repetitive one-case notes.
- Preserve still-useful existing knowledge whenever possible.
- Prefer additive maintenance over replacement.
- First choice: append a focused addendum to an existing relevant module.
- Second choice: create a small new Markdown module for a recurring lesson, exception, note, execution reminder, or tool guide.
- If solve behavior would clearly benefit from reusable local tooling, a narrow helper asset under `tools/` or `skills/` is also allowed.
- Only lightly update entry navigation so future solve agents can discover the new additive memory.
- Avoid deleting, broadly rewriting, splitting, or merging existing canonical modules in this method.
- If several shard cases are repeating the same idea, compress them into one clearer rule or one focused additive lesson instead of writing five separate notes.
- If the previous batch maintenance round was rejected, use the rejection evidence to make the next change narrower, safer, and more batch-general.
