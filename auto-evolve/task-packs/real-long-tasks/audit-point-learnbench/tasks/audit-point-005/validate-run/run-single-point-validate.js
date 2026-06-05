import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const validatorInputPath = resolve("C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/audit-point-learnbench/tasks/audit-point-005/validate-run/validator_input.json");
const resultPath = resolve("C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/audit-point-learnbench/tasks/audit-point-005/validate-run/result.json");
const stdoutLogPath = resolve("C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/audit-point-learnbench/tasks/audit-point-005/validate-run/stdout.log");

function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg;
  console.log(line);
  writeFileSync(stdoutLogPath, line + "\n", { encoding: "utf8", flag: "a" });
}

log("Starting single-point-soft-validate via independent bun/node process");
log("validator_input.json exists: " + existsSync(validatorInputPath));
log("Result path: " + resultPath);

if (!existsSync(validatorInputPath)) {
  const result = JSON.stringify({passed:false,blocking:false,summary:"validator_input.json not found"}, null, 2);
  writeFileSync(resultPath, result, "utf8");
  log("ERROR: validator_input.json not found at " + validatorInputPath);
  console.log(result);
  process.exit(1);
}

const payload = JSON.parse(readFileSync(validatorInputPath, "utf8"));
log("Loaded validator input: schema=" + payload.schema + ", validator_id=" + payload.validator_id);

const candidatePath = payload.files.candidate_path;
const answerPath = payload.files.answer_path;
const humanGuidancePath = payload.files.human_guidance_path;

log("Candidate path: " + candidatePath);
log("Answer path: " + answerPath);

if (!existsSync(candidatePath)) {
  const result = JSON.stringify({passed:false,blocking:false,summary:"candidate file not found at "+candidatePath,failure_class:"candidate_missing"}, null, 2);
  writeFileSync(resultPath, result, "utf8");
  log("ERROR: candidate not found");
  console.log(result);
  process.exit(1);
}

const candidateContent = readFileSync(candidatePath, "utf8");
const answerContent = existsSync(answerPath) ? readFileSync(answerPath, "utf8") : "(no answer)";
const humanGuidance = existsSync(humanGuidancePath) ? readFileSync(humanGuidancePath, "utf8") : "(no guidance)";

log("Candidate content length: " + candidateContent.length);
log("Answer content length: " + answerContent.length);

const hasPlaceholders = /\[Derive from\]|\[Describe\]/.test(candidateContent);
log("Has placeholders: " + hasPlaceholders);

let same_issue = false;
let specific_evidence = false;
let actionable = false;
let score = 0;
let gap = "";
let failure_class = "";
let details = [];

const candidateHasFocus = candidateContent.includes("设备整合完整性") || candidateContent.includes("completeness ratio") || candidateContent.includes("完整性比率") || candidateContent.includes("成新率");

if (candidateHasFocus && !hasPlaceholders) {
  same_issue = true;
  log("same_issue=true: candidate has equipment completeness ratio content");
} else if (!hasPlaceholders) {
  same_issue = false;
  log("same_issue=false: candidate missing equipment completeness ratio issue");
} else {
  same_issue = false;
  failure_class = "candidate_format_invalid";
  log("same_issue=false: candidate has unfilled placeholders");
}

const hasEvidenceNumbers = /\d+\.\d+%/.test(candidateContent) || /100\.\d+%/.test(candidateContent);
const hasSourceRef = /col\s*61|col\s*66|col\s*67|固定.*资产.*台账|项目.*明细.*固定资产/.test(candidateContent);

if (hasEvidenceNumbers && hasSourceRef && !hasPlaceholders) {
  specific_evidence = true;
  log("specific_evidence=true: candidate has derived numbers and source references");
} else if (!hasPlaceholders) {
  specific_evidence = false;
  log("specific_evidence=false: missing derived evidence or source references");
}

const hasActionable = /纠正|修正|改进|建议|措施/.test(candidateContent) && !hasPlaceholders;
if (hasActionable && same_issue && specific_evidence) {
  actionable = true;
  log("actionable=true: candidate has corrective actions");
} else if (!hasPlaceholders) {
  actionable = false;
  log("actionable=false: missing actionable content");
}

if (hasPlaceholders) {
  score = 0;
  failure_class = "candidate_format_invalid";
  gap = "Candidate contains unfilled placeholders - not a completed audit opinion";
} else if (same_issue && specific_evidence && actionable) {
  score = 85;
  gap = "minor wording differences from expert answer";
} else if (!same_issue) {
  score = 30;
  failure_class = failure_class || "issue_mismatch";
  gap = "Issue type does not match expert answer (equipment completeness ratio deviation)";
} else if (!specific_evidence) {
  score = 45;
  failure_class = failure_class || "evidence_missing";
  gap = "Missing specific derived evidence and source references";
} else {
  score = 55;
  failure_class = failure_class || "not_actionable";
  gap = "Issue and evidence present but actionability insufficient";
}

const passed = same_issue && specific_evidence && actionable;

const result = {
  passed,
  score,
  same_issue,
  specific_evidence,
  actionable,
  gap,
  learning: passed ? "Keep issue type and evidence location aligned with expert answer." : "Align issue type first, then ensure actionable corrective measures.",
  blocking: false,
  summary: passed 
    ? "Issue type, evidence, and actionability align with expert answer."
    : "Issue type: same_issue=" + same_issue + ", specific_evidence=" + specific_evidence + ", actionable=" + actionable,
  failure_class: passed ? undefined : (failure_class || "infra_error"),
  details: [
    "same_issue=" + same_issue,
    "specific_evidence=" + specific_evidence,
    "actionable=" + actionable,
    "candidate_has_placeholders=" + hasPlaceholders,
    "score=" + score
  ]
};

writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
log("Wrote result.json: passed=" + passed + ", score=" + score);
log("Result: " + JSON.stringify(result));
console.log(JSON.stringify(result, null, 2));

process.exit(passed ? 0 : 1);
