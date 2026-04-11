This judge run supports the parallel-batch-5-add-only method.

Routing hints:

- classification: {{routing_classification}}
- preferred files: {{preferred_files}}
- suggested roles: {{suggested_roles}}
- routing reasons: {{routing_reasons}}

Parallel batch add-only judge expectations:

- Judge the current case as one shard inside a larger micro-batch.
- Prefer starting maintenance when the shard failure looks like a missing lesson, missing exception, missing execution reminder, missing tool note, or missing output-discipline reminder that could be valuable across multiple similar cases.
- Be cautious about asking for maintenance when the current case appears to need a broad structural rewrite that a conservative batch add-only update is unlikely to handle well.
- Your job is to help decide whether this case should contribute to the batch learning packet, not to authorize a one-case broad rewrite.
