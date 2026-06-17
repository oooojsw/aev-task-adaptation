import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const vd = "C:/Users/ZhuanZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/audit-point-learnbench/tasks/audit-point-010/validate-run";
const VIP = resolve(vd + "/validator_input.json");
const RP = resolve(vd + "/result.json");
const LP = resolve(vd + "/stdout.log");

function log(m) {
  writeFileSync(LP, "[" + new Date().toISOString() + "] " + m + "\n", {encoding:"utf8", flag:"a"});
}

log("Start");

if (!existsSync(VIP)) {
  writeFileSync(RP, JSON.stringify({passed:false,blocking:false,summary:"input not found"}, null, 2), "utf8");
  process.exit(1);
}

const p = JSON.parse(readFileSync(VIP, "utf8"));
const cp = p.files.candidate_path;
const ap = p.files.answer_path;
const hp = p.files.human_guidance_path;

if (!existsSync(cp)) {
  writeFileSync(RP, JSON.stringify({passed:false,blocking:false,summary:"candidate not found",failure_class:"candidate_missing"}, null, 2), "utf8");
  process.exit(1);
}

const cc = readFileSync(cp, "utf8");
const ac = existsSync(ap) ? readFileSync(ap, "utf8") : "NO_ANSWER";
const hc = existsSync(hp) ? readFileSync(hp, "utf8") : "NO_GUIDANCE";

log("Candidate length: " + cc.length + ", Answer: " + ac.length);

const ph = /\[Derive from\]|\[Describe\]/.test(cc);
const si = cc.includes("growth") || cc.includes("revenue") || cc.includes("forecast") || cc.includes("增长") || cc.includes("收入");
const hn = /\d+[.,]\d+/.test(cc) && /\d+%/.test(cc);
const hs = /sheet|row|column|\d{4}/.test(cc);
const se = hn && hs;
const ha = /obtain|adjust|align|request|provide|confirm|revise/.test(cc);
const ar = ha && si && se;

log("si=" + si + ", se=" + se + ", ar=" + ar);

let score = 0, gap = "", fc = "";
if (ph) { score = 0; fc = "candidate_format_invalid"; gap = "placeholders"; }
else if (si && se && ar) { score = 85; gap = "minor"; }
else if (!si) { score = 30; fc = "issue_mismatch"; gap = "issue mismatch"; }
else if (!se) { score = 45; fc = "evidence_missing"; gap = "no evidence"; }
else { score = 55; fc = "not_actionable"; gap = "weak action"; }

const passed = si && se && ar;
const result = {passed, score, same_issue:si, specific_evidence:se, actionable:ar, gap, learning:passed ? "Keep aligned." : "Fix issue first.", blocking:false, summary:passed ? "All met." : "si=" + si + ", se=" + se + ", ar=" + ar, failure_class:passed ? undefined : fc, details:["si=" + si, "se=" + se, "ar=" + ar, "score=" + score]};

writeFileSync(RP, JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
process.exit(passed ? 0 : 1);