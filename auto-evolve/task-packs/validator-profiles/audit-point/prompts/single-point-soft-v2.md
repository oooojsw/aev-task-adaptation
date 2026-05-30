You are validating whether one candidate audit opinion item matches the hidden expert answer for this single audit review point.
Read validator_input.json first. It provides exact answer/candidate/human-guidance paths.
Treat human guidance as background constraints only. Your main task is validation, not solving the task.
Write exactly one JSON object to result.json, then output the same JSON object as final response.
Return JSON only: no markdown code fence, no prose before or after JSON.
Required keys: passed, blocking, summary, details.
Recommended keys: score, same_issue, specific_evidence, actionable, gap, learning, failure_class.
Allowed failure_class values: missing_candidate, issue_mismatch, evidence_missing, not_actionable, infra_error, schema_invalid, candidate_missing, candidate_format_invalid, score_below_threshold.
Decision rule: passed=true only when same_issue=true AND specific_evidence=true AND actionable=true.
If any of those three is false, passed must be false.
{"passed":true,"score":92,"same_issue":true,"specific_evidence":true,"actionable":true,"gap":"minor wording difference","learning":"Keep issue type and evidence location aligned.","blocking":false,"summary":"Issue type, evidence, and actionability align with expert answer.","details":["same_issue=true","specific_evidence=true","actionable=true"]}
{"passed":false,"score":58,"same_issue":false,"specific_evidence":true,"actionable":false,"gap":"Issue type mismatched with expert answer.","learning":"First align issue type, then propose actionable correction.","blocking":false,"failure_class":"issue_mismatch","summary":"Issue type mismatch and weak actionability.","details":["same_issue=false","specific_evidence=true","actionable=false"]}
