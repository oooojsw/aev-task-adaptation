import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const base = "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/audit-point-learnbench/tasks/audit-point-013";
const validatorInputPath = resolve(base + "/validate-run/validator_input.json");
const resultPath = resolve(base + "/validate-run/result.json");
const stdoutLogPath = resolve(base + "/validate-run/stdout.log");

function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg;
  console.log(line);
  writeFileSync(stdoutLogPath, line + "\n", { encoding: "utf8", flag: "a" });
}

log("Starting single-point-soft-validate for audit-point-013");
log("validator_input.json exists: " + existsSync(validatorInputPath));

const payload = JSON.parse(readFileSync(validatorInputPath, "utf8"));
const candidatePath = payload.files.candidate_path;
const answerPath = payload.files.answer_path;

log("Candidate path: " + candidatePath);
log("Answer path: " + answerPath);

const candidateContent = readFileSync(candidatePath, "utf8");
const answerContent = existsSync(answerPath) ? readFileSync(answerPath, "utf8") : "(no answer)";

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

const candidateHasAdjIssue = /ADJ.*H10.*H83|H10.*H83/i.test(candidateContent) || /Adj.*cross-reference/i.test(candidateContent);
const answerHasAdjIssue = /ADJ.*H10.*H83|H10.*H83/i.test(answerContent) || /Adj.*cross-reference/i.test(answerContent);

if (candidateHasAdjIssue && answerHasAdjIssue && !hasPlaceholders) {
  same_issue = true;
  log("same_issue=true: both candidate and answer reference ADJ H10/H83 issue");
} else if (!hasPlaceholders) {
  same_issue = false;
  log("same_issue=false: candidate does not match ADJ H10/H83 issue in answer");
} else {
  same_issue = false;
  failure_class = "candidate_format_invalid";
  log("same_issue=false: candidate has unfilled placeholders");
}

const hasH10None = /H10.*None|H10.*empty/i.test(candidateContent);
const hasH83Value = /H83.*-279/i.test(candidateContent);
const hasSourceRef = /materials.*dingao|xlsm/i.test(candidateContent);

if (hasH10None && hasH83Value && hasSourceRef && !hasPlaceholders) {
  specific_evidence = true;
  log("specific_evidence=true: candidate has H10=None, H83=-279, and source reference");
} else if (!hasPlaceholders) {
  specific_evidence = false;
  log("specific_evidence=false: missing specific evidence for H10/H83 cells");
}

const hasActionable = /correction|verify|navigate|compare|determine|request/i.test(candidateContent) && !hasPlaceholders;
if (hasActionable && same_issue && specific_evidence) {
  actionable = true;
  log("actionable=true: candidate has corrective action steps");
} else if (!hasPlaceholders) {
  actionable = false;
  log("actionable=false: missing actionable content");
}

if (hasPlaceholders) {
  score = 0;
  failure_class = "candidate_format_invalid";
  gap = "Candidate contains unfilled placeholders";
} else if (same_issue && specific_evidence && actionable) {
  score = 85;
  gap = "minor wording differences from expert answer";
} else if (!same_issue) {
  score = 30;
  failure_class = failure_class || "issue_mismatch";
  gap = "Issue type does not match expert answer (ADJ H10 vs H83 inconsistency)";
} else if (!specific_evidence) {
  score = 45;
  failure_class = failure_class || "evidence_missing";
  gap = "Missing specific derived evidence for H10/H83 cells";
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
    : "same_issue=" + same_issue + ", specific_evidence=" + specific_evidence + ", actionable=" + actionable,
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