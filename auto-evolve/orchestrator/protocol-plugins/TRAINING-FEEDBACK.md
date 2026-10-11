# Training feedback visibility

Each declared protocol check may select feedback:

- status_only (default): training receives check name, target and outcome.
- checker_message: explicit authorization to disclose ordinary passed/rejected
  checker text to training. The adapter must ensure that message is appropriate
  for disclosure; this option is not automatic redaction or a model privacy judge.

Scoring/data/interruption errors never forward raw checker messages, including
when checker_message is selected. They remain stop conditions, not requests to
revise Skill. Unknown policy blocks compilation; changing policy changes the
frozen protocol fingerprint and blocks recovery under another policy.

Campaign training summaries and evidence references use a separate
protocol.training-feedback.json view. Raw protocol.receipt.json remains intact
for audit. Merge repair author requests apply the same selected check policy.
Held-out tests do not initiate repair. Legacy acceptance behavior is unchanged.

This controls explicitly constructed summaries and repair prompts. It does not
prove operating-system isolation or eliminate every broader Campaign file-read
permission. Role evidence-read paths still require separate final audit. Old
development result files are not silently rewritten into feedback views.
