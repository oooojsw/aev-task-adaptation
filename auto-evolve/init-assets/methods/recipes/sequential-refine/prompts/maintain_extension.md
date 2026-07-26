This maintenance round follows the sequential-refine baseline.

Use the selected session execution reports in this order:

1. Read the current failed solve session report first.
2. Read the regression-before-maintain session reports as guardrails so you do not damage already-working behavior.
3. If previous attempts exist, read the previous maintain and verify reports to avoid repeating the same bad repair pattern.

Sequential-refine expectations:

- classification: {{routing_classification}}
- preferred files: {{preferred_files}}
- suggested roles: {{suggested_roles}}
- routing reasons: {{routing_reasons}}

Specific behavioral guidance:

- Prefer the smallest durable correction that fixes the current failure pattern.
- Avoid converting one local mistake into a global rule rewrite unless the evidence clearly supports it.
- If previous reports show repeated useless exploration or repeated wrong tool habits, encode an explicit warning or execution rule so future solve agents avoid that path.
- If regression-before-maintain reports show existing successful behavior, preserve the structure that supports those successes.
- Do not create multiple competing versions of the same expert knowledge inside the workspace for this baseline method.
