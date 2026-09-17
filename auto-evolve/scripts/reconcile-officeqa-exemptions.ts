import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, copyFile } from "node:fs/promises"
import { writeFileAtomic, writeJsonAtomic } from "../orchestrator/atomic-write"
import { identifyProcessOwner } from "../orchestrator/process-identity"

const args = process.argv.slice(2)
const runArg = args[args.indexOf("--run") + 1]
if (!args.includes("--run") || !runArg) throw new Error("Usage: --run <existing run> [--apply]")
const run = path.resolve(runArg)
const statePath = path.join(run, "orchestrator-state.json")
const read = async (file: string) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
const state = await read(statePath)
if (state.phase !== "completed") throw new Error("Reconciliation requires a completed, idle benchmark.")
const processResult = spawnSync("python", [path.join(import.meta.dir, "audit-officeqa-acceptance.py"), "--run", run], {
  encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
})
if (processResult.error || processResult.status !== 0) throw new Error(processResult.stderr || String(processResult.error))
const audit = JSON.parse(processResult.stdout)
if (audit.auditErrors) throw new Error("Incomplete audit; no status changes allowed.")
const rejected = audit.rows.filter((row: any) => !row.passed)
if (rejected.some((row: any) => row.oldMethod !== "data-unavailable-blocked")) {
  throw new Error("Unexpected mismatch requires investigation; no status changes allowed.")
}
const stamp = new Date().toISOString()
const auditDir = path.join(run, "acceptance-audits", stamp.replace(/[:.]/g, "-"))
await mkdir(auditDir, { recursive: true })
const auditPath = path.join(auditDir, "audit.json")
await writeJsonAtomic(auditPath, audit)
if (!args.includes("--apply") || !rejected.length) {
  console.log(JSON.stringify({ auditPath, reviewed: audit.reviewed, passed: audit.passed, rejected: rejected.map((r: any) => r.id), applied: false }))
  process.exit(0)
}
const ids = new Set<string>(rejected.map((row: any) => row.id))
const reason = "Acceptance invalidated: data-unavailable-blocked is not answer correctness."
const changes: Array<{ file: string; before: string; after: string }> = []
async function change(file: string, mutate: (data: any) => any) {
  const before = await readFile(file, "utf8")
  const after = JSON.stringify(mutate(JSON.parse(before.replace(/^\uFEFF/, ""))), null, 2) + "\n"
  changes.push({ file, before, after })
}
// 先保存全部原件再纠正当前索引；历史答卷和验收证据保持原样。
for (const row of rejected) {
  const file = path.join(row.campaignDir, "campaign.json")
  const campaign = await read(file)
  if (campaign.status !== "verified_success" || campaign.lastFinalAcceptanceResultPath !== row.acceptancePath) {
    throw new Error(`Campaign changed during audit: ${row.id}`)
  }
  const owner = await identifyProcessOwner({ pid: campaign.ownerPID, expectedCreationTick: campaign.ownerCreationTick,
    requiredCommandHints: [campaign.id], heartbeatAt: campaign.heartbeatAt })
  if (owner.ownership === "owned" || owner.ownership === "unknown_owner") throw new Error(`Owner not idle: ${row.id}`)
  if (createHash("sha256").update(await readFile(row.candidatePath)).digest("hex") !== row.candidateSha256) {
    throw new Error(`Candidate changed during audit: ${row.id}`)
  }
  await change(file, (data) => ({ ...data, status: "failed", lastFinalAcceptancePassed: false,
    lastRunHardVerified: false, lastRoundClosure: "closed_repairable", lastSummary: reason,
    updatedAt: stamp, acceptanceInvalidation: { reason, auditPath, at: stamp },
    reuse: { ...data.reuse, allowed: false, tainted: true } }))
}
await change(path.join(run, "task-ledger.json"), (data) => {
  for (const id of ids) {
    const task = data.tasks[id]
    const row = rejected.find((r: any) => r.id === id)
    if (!task || path.resolve(task.activeCampaignDir) !== path.resolve(row.campaignDir)) throw new Error(`Ledger diverged: ${id}`)
    task.status = "failed"
    task.updatedAt = stamp
    task.acceptanceInvalidation = { reason, auditPath, at: stamp }
    for (const attempt of task.attempts) if (attempt.attemptID === task.activeAttemptID) {
      attempt.status = "terminal"
      attempt.reason = reason
      attempt.updatedAt = stamp
    }
  }
  data.updatedAt = stamp
  return data
})
await change(statePath, (data) => {
  for (const row of data.trainResults) if (ids.has(row.id)) {
    row.status = "failed"
    row.updatedAt = stamp
    row.acceptanceInvalidation = { reason, auditPath }
  }
  data.updatedAt = stamp
  return data
})
await change(path.join(run, "final-report.json"), (data) => ({ ...data, trainVerified: audit.passed,
  acceptanceAuditPath: auditPath, invalidatedSuccessIDs: [...ids] }))
await change(path.join(run, "verified-training.json"), (data) => data.filter((row: any) => !ids.has(row.id)))
let correctedQueue: any[] = []
await change(path.join(run, "train-queue-results.json"), (data) => correctedQueue = data.map((row: any) =>
  ids.has(row.id) && row.status === "verified_success"
    ? { ...row, status: "failed", verified: false, code: 1, acceptanceInvalidation: { reason, auditPath } } : row))
await change(path.join(run, "train-queue-summary.json"), (data) => ({ ...data,
  verified: correctedQueue.filter((row) => row.status === "verified_success").length,
  failed: correctedQueue.filter((row) => row.status === "failed").length,
  acceptanceAuditPath: auditPath, invalidatedSuccessIDs: [...ids] }))
const scorecardPath = path.join(run, "scorecard.md")
const before = await readFile(scorecardPath, "utf8")
let after = before.replace(/verified_success: \*\*\d+\*\*/, `verified_success: **${audit.passed}**`)
  .replace(/other terminal states: \*\*\d+\*\*/, `other terminal states: **${state.trainIDs.length - audit.passed}**`)
for (const id of ids) after = after.replace(`| \`${id}\` | \`verified_success\` |`, `| \`${id}\` | \`failed\` |`)
after += `\nAcceptance audit ${stamp}: revoked ${[...ids].join(", ")}; original evidence preserved.\nAudit: ${auditPath}\n`
changes.push({ file: scorecardPath, before, after })
for (const item of changes) if (await readFile(item.file, "utf8") !== item.before) throw new Error(`Concurrent modification: ${item.file}`)
const backups = []
for (const [index, item] of changes.entries()) {
  const backup = path.join(auditDir, `before-${index}-${path.basename(item.file)}`)
  await copyFile(item.file, backup)
  backups.push({ file: item.file, backup, sha256: createHash("sha256").update(item.before).digest("hex") })
}
await writeJsonAtomic(path.join(auditDir, "backups.json"), backups)
for (const item of changes) await writeFileAtomic(item.file, item.after)
await writeJsonAtomic(path.join(auditDir, "applied.json"), { at: stamp, ids: [...ids], files: changes.map((x) => x.file) })
console.log(JSON.stringify({ auditPath, reviewed: audit.reviewed, passed: audit.passed, rejected: [...ids], applied: true }))
