#!/usr/bin/env bun
// patch-campaign-maxrounds.ts
// 一次性补丁：把 50 个真训练集的 task 目录里的 campaign.json 的 maxRounds 字段
// 统一升级到 OFFICEQA_PRO_CAMPAIGN_ROUNDS（默认 7）。
// 只改 campaign.json，不动 task 目录里其他任何文件（workspace / expert-workspace /
// materials / spec.json / instruction.md / private-answers 全部不动）。
//
// 用法：
//   OFFICEQA_PRO_DRY_RUN=1 bun run scripts/patch-campaign-maxrounds.ts  # 先看计划
//   bun run scripts/patch-campaign-maxrounds.ts                          # 真改
//
// 设计：
//   - 读 train-50-skillopt.json（50 个 UID）
//   - 对每个 UID，读 tasks/<UID>/campaign.json，改 maxRounds，写回（保持其他字段不动）
//   - 改前快照到 <outRoot>/.task-snapshots/<ts>/patch-maxrounds/<UID>/campaign.json
//   - 改前自动备份当前 campaign.json 到 campaign.json.bak-<ts>
//   - DRY_RUN 模式只打印计划，不动文件
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, readdirSync } from "node:fs"
import path from "node:path"

const cwd = path.resolve(import.meta.dir, "..", "..")
const auto = path.join(cwd, "auto-evolve")
const outRoot = path.join(auto, "task-packs", "real-long-tasks", "officeqa-pro-learnbench")
const splitPath = path.join(outRoot, "splits", "train-50-skillopt.json")
const dryRun = process.env.OFFICEQA_PRO_DRY_RUN === "1"
const targetRounds = Math.max(1, Number.parseInt(process.env.OFFICEQA_PRO_CAMPAIGN_ROUNDS ?? "7", 10))

if (!existsSync(splitPath)) {
  throw new Error(`train-50-skillopt.json not found at ${splitPath}. Run create-officeqa-pro-experiment.ts first.`)
}
const uids: string[] = JSON.parse(readFileSync(splitPath, "utf8"))
const stamp = new Date().toISOString().replace(/[:.]/g, "-")

const plan: any[] = []
const skipped: string[] = []
const failed: string[] = []
let totalChanged = 0
let totalAlreadyAtTarget = 0
let totalMissing = 0

for (const uid of uids) {
  const taskDir = path.join(outRoot, "tasks", uid)
  const campaignPath = path.join(taskDir, "campaign.json")
  if (!existsSync(taskDir) || !existsSync(campaignPath)) {
    totalMissing += 1
    plan.push({ uid, action: "skip", reason: "task dir or campaign.json missing" })
    continue
  }
  let cur: any
  try {
    cur = JSON.parse(readFileSync(campaignPath, "utf8"))
  } catch (e) {
    failed.push(uid)
    plan.push({ uid, action: "skip", reason: `parse failed: ${(e as Error).message}` })
    continue
  }
  const current = cur.maxRounds
  if (current === targetRounds) {
    totalAlreadyAtTarget += 1
    plan.push({ uid, action: "no-op", current, target: targetRounds })
    continue
  }
  plan.push({ uid, action: "change", from: current, to: targetRounds })
  if (dryRun) continue
  // 1) snapshot full task dir runtime (very small) to .task-snapshots/<ts>/patch-maxrounds/<UID>/
  const snapDir = path.join(outRoot, ".task-snapshots", stamp, "patch-maxrounds", uid)
  mkdirSync(snapDir, { recursive: true })
  copyFileSync(campaignPath, path.join(snapDir, "campaign.json"))
  // 2) backup current campaign.json next to it
  copyFileSync(campaignPath, path.join(taskDir, `campaign.json.bak-${stamp}`))
  // 3) rewrite maxRounds
  cur.maxRounds = targetRounds
  writeFileSync(campaignPath, JSON.stringify(cur, null, 2) + "\n", "utf8")
  totalChanged += 1
}

// write a plan log so the user can audit
const logDir = path.join(outRoot, ".task-snapshots", stamp, "patch-maxrounds")
mkdirSync(logDir, { recursive: true })
const logPath = path.join(logDir, "patch-plan.json")
writeFileSync(logPath, JSON.stringify({
  mode: dryRun ? "DRY_RUN" : "APPLIED",
  stamp,
  targetRounds,
  totalUids: uids.length,
  totalChanged,
  totalAlreadyAtTarget,
  totalMissing,
  failed,
  plan,
}, null, 2) + "\n", "utf8")

console.log(JSON.stringify({
  mode: dryRun ? "DRY_RUN" : "APPLIED",
  stamp,
  targetRounds,
  totalUids: uids.length,
  totalChanged,
  totalAlreadyAtTarget,
  totalMissing,
  failed,
  plan: plan.filter((p) => p.action === "change"),
  logPath,
}, null, 2))
