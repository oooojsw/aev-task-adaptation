import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const validatorInputPath = resolve("C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/audit-point-learnbench/tasks/audit-point-016/validate-run/validator_input.json");
const resultPath = resolve("C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/audit-point-learnbench/tasks/audit-point-016/validate-run/result.json");
const stdoutLogPath = resolve("C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/audit-point-learnbench/tasks/audit-point-016/validate-run/stdout.log");

function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg;
  console.log(line);
  writeFileSync(stdoutLogPath, line + "\n", { encoding: "utf8", flag: "a" });
}

log("Starting single-point-soft-validate for audit-point-016");
log("validator_input.json exists: " + existsSync(validatorInputPath));

if (!existsSync(validatorInputPath)) {
  const result = JSON.stringify({passed:false,blocking:false,summary:"validator_input.json not found"}, null, 2);
  writeFileSync(resultPath, result, "utf8");
  console.log(result);
  process.exit(1);
}

const payload = JSON.parse(readFileSync(validatorInputPath, "utf8"));
log("Loaded validator input: schema=" + payload.schema + ", validator_id=" + payload.validator_id);

const candidatePath = payload.files.candidate_path;
const answerPath = payload.files.answer_path;

log("Candidate path: " + candidatePath);
log("Answer path: " + answerPath);

if (!existsSync(candidatePath)) {
  const result = JSON.stringify({passed:false,blocking:false,summary:"candidate file not found","failure_class":"candidate_missing"}, null, 2);
  writeFileSync(resultPath, result, "utf8");
  log("ERROR: candidate not found");
  console.log(result);
  process.exit(1);
}

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
let details = [];

// Audit point 016: building table AG9 content cleared
// Expert answer says: building table AG9 should be blank (cleared)
// Candidate wrote about accounts payable AG9='2023' (populated) - this is ISSUE MISMATCH
const candidateHasAG9Ref = /AG9|AG-9|AG 9/.test(candidateContent);
const candidateHasBuildingTableRef = /建筑物表|building.*table|building.*asset/.test(candidateContent.toLowerCase());
const candidateHasAccountsPayableRef = /应付账款|accounts payable/.test(candidateContent);

// Check same_issue: does candidate address the AG9 cleared issue correctly?
// The correct issue is: building table AG9 content was cleared (blank)
// The candidate found accounts payable AG9='2023' (populated) - WRONG SOURCE
if (candidateHasAG9Ref && !hasPlaceholders) {
  // Check if candidate is about building table AG9 being blank vs accounts payable
  if (candidateHasBuildingTableRef && !candidateHasAccountsPayableRef) {
    same_issue = true;
    log("same_issue=true: candidate references building table AG9");
  } else if (candidateHasAccountsPayableRef) {
    // Wrong source - accounts payable AG9 is not the audit target
    same_issue = false;
    failure_class = "issue_mismatch";
    log("same_issue=false: candidate references accounts payable AG9, not building table AG9");
  } else {
    // AG9 referenced but unclear source
    same_issue = false;
    failure_class = "issue_mismatch";
    log("same_issue=false: AG9 referenced but source unclear");
  }
} else if (!hasPlaceholders) {
  same_issue = false;
  log("same_issue=false: candidate missing AG9 reference");
} else {
  same_issue = false;
  failure_class = "candidate_format_invalid";
  log("same_issue=false: candidate has unfilled placeholders");
}

// Check specific_evidence: cell reference, source file, value, context
const hasCellRef = /AG9|AG-9|AG 9|cell.*AG|col.*33/.test(candidateContent);
const hasSourceFile = /Ʊ账明细|应付账款|accounts payable|building asset|BUILDING/i.test(candidateContent);
const hasValue = /blank|empty|空白|空|cleared|2023/.test(candidateContent);
const hasContext = /第9行|row 9|9行|AF9|AH9/.test(candidateContent);

if (hasCellRef && hasSourceFile && hasValue && hasContext && !hasPlaceholders) {
  specific_evidence = true;
  log("specific_evidence=true: candidate has cell ref, source, value, context");
} else if (!hasPlaceholders) {
  specific_evidence = false;
  log("specific_evidence=false: missing evidence components");
  if (!hasCellRef) log("  missing: cell reference");
  if (!hasSourceFile) log("  missing: source file");
  if (!hasValue) log("  missing: value");
  if (!hasContext) log("  missing: context");
}

// Check actionable: corrective actions present
const hasActionable = /建议|校正|改进|措施|整改|请求|请/.test(candidateContent) && !hasPlaceholders;
if (hasActionable && same_issue && specific_evidence) {
  actionable = true;
  log("actionable=true: candidate has corrective actions");
} else if (!hasPlaceholders) {
  actionable = false;
  log("actionable=false: missing actionable content or prerequisites not met");
}

// Determine score and gap
if (hasPlaceholders) {
  score = 0;
  failure_class = "candidate_format_invalid";
  gap = "Candidate contains unfilled placeholders - not a completed audit opinion";
} else if (!same_issue) {
  score = 30;
  failure_class = failure_class || "issue_mismatch";
  gap = "Issue mismatch: candidate wrote about accounts payable AG9='2023' (populated), but audit topic '建筑物表 AG9 内容清除' expects building table AG9 blank (cleared). Wrong source document.";
} else if (!specific_evidence) {
  score = 45;
  failure_class = failure_class || "evidence_missing";
  gap = "Missing specific evidence components (cell ref, source, value, or context)";
} else if (!actionable) {
  score = 55;
  failure_class = failure_class || "not_actionable";
  gap = "Issue and evidence present but actionability insufficient";
} else {
  score = 85;
  gap = "minor wording differences from expert answer";
}

const passed = same_issue && specific_evidence && actionable;

const result = {
  passed,
  score,
  same_issue,
  specific_evidence,
  actionable,
  gap,
  learning: passed ? "Keep issue type and evidence location aligned with expert answer." : "Align issue type first - check that AG9 reference is from building table, not accounts payable register.",
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
    "score=" + score,
    "candidate_has_AG9_ref=" + candidateHasAG9Ref,
    "candidate_has_building_table_ref=" + candidateHasBuildingTableRef,
    "candidate_has_accounts_payable_ref=" + candidateHasAccountsPayableRef
  ]
};

writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
log("Wrote result.json: passed=" + passed + ", score=" + score);
log("Result: " + JSON.stringify(result));
console.log(JSON.stringify(result, null, 2));

process.exit(passed ? 0 : 1);
