This judge round follows the sequential-refine baseline.

Sequential-refine judge priorities:

- classification: {{routing_classification}}
- preferred files: {{preferred_files}}
- suggested roles: {{suggested_roles}}
- routing reasons: {{routing_reasons}}

Judge guidance:

- Be conservative about starting maintenance if the failure looks like transient noise only.
- Be strict about starting maintenance if the failure is stable, repeatable, or obviously reflects missing experience guidance.
- Pay special attention to whether the failed solve session shows repetitive useless exploration, repeated empty reads, or obvious tool misuse.
- Preserve already-working behavior: regression-before-maintain reports are strong evidence that some existing structure is worth protecting.
