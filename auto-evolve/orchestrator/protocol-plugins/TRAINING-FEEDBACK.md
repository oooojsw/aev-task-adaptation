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

Campaign also saves result.json.training.json without protocolReceiptPath and
protocolAuditResultPath. New-protocol repair tickets, experience logs, diagnosis
and next-pass feedback reference this training result. The Campaign terminal
state retains original result.json for identity verification and completed reuse.
New-protocol Campaigns do not construct legacy expert-oracle bundles from prior
or current acceptance. Actual lifecycle tests inspect role prompt/read lists and
check modified training-result recovery blocks without additional calls.

This controls explicitly constructed summaries and repair prompts. It does not
prove operating-system isolation or eliminate every broader Campaign file-read
permission. Broader training tool/private-material permissions still require
separate final audit. Old
development result files are not silently rewritten into feedback views.
