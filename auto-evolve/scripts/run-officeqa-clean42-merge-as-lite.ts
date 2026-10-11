import path from "node:path"
import { createHash } from "node:crypto"
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { readJsonFile, writeJsonFile, pathExists } from "../orchestrator/fs"
import { runLiteMerger } from "../orchestrator/multi-instance/lite-merger"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const materialRoot = "E:/project/SkillOptlite-merge-runs/officeqa-clean50-materialized-20260922"
const out = "E:/project/SkillOptlite-merge-runs/officeqa-clean41-merge-as-lite-clean50-minimax27-20260922"
const sourceManifest = "E:/project/SkillOpt-length-cap-runs/officeqa-clean42-length5768-minimax27-20260921/experiment-manifest.json"
const capBytes = 5768
const excludedLabelConflict = "UID0165"

type Source = { id: string; skillRoot: string; packageHash: string }

async function digestDirectory(root: string) {
  const hash = createHash("sha256")
  async function visit(current: string) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute).replaceAll("\\", "/")
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) {
        hash.update(relative)
        hash.update("\0")
        hash.update(await readFile(absolute))
        hash.update("\0")
      } else throw new Error(`Unsupported source entry: ${absolute}`)
    }
  }
  await visit(root)
  return hash.digest("hex")
}

async function splitIDs(name: string) {
  const rows = await readJsonFile<Array<{ id?: string; uid?: string }>>(path.join(materialRoot, "split", name, "items.json"), { validatePaths: false })
  const ids = rows.map((row) => row.uid ?? row.id ?? "")
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error(`Invalid ${name} UID set`)
  return new Set(ids)
}

async function evaluateTest(skillPath: string, authFile: string, pythonCommand: string, runtimeRoot: string) {
  const evalOut = path.join(out, "final-test")
  const summaryPath = path.join(evalOut, "eval_summary.json")
  if (!(await pathExists(summaryPath))) {
    const runner = path.join(runtimeRoot, "tools", "lite_minimax_runner.py")
    const config = path.join(runtimeRoot, "configs", "officeqa", "default.yaml")
    const command = [
      pythonCommand, runner,
      "--auth-file", authFile, "--provider-id", "minimax-cn-coding-plan", "--model", "MiniMax-M2.7",
      "eval", "--config", config, "--skill", skillPath, "--split", "test", "--target_model", "MiniMax-M2.7",
      "--split_dir", path.join(materialRoot, "split"), "--test_env_num", "0", "--workers", "3",
      "--max_api_workers", "3", "--out_root", evalOut, "--cfg-options", "env.search_mode=offline",
    ]
    const child = Bun.spawn(command, {
      cwd: runtimeRoot,
      env: { ...process.env, OFFICEQA_DOCS_DIR: path.join(materialRoot, "docs"), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      stdout: "pipe", stderr: "pipe",
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const code = await child.exited
    await Promise.all([
      writeFile(path.join(out, "final-test.stdout.log"), await stdout, "utf8"),
      writeFile(path.join(out, "final-test.stderr.log"), await stderr, "utf8"),
    ])
    if (code !== 0) throw new Error(`Lite held-out evaluator exited ${code}; inspect final-test stderr`)
  }
  const summary = await readJsonFile<{ n_items: number; hard: number; soft: number }>(summaryPath)
  const testIDs = await splitIDs("test")
  const lines = (await readFile(path.join(evalOut, "results.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean)
  const actual = lines.map((line) => String((JSON.parse(line) as { id?: string }).id ?? ""))
  if (summary.n_items !== testIDs.size || actual.length !== testIDs.size || new Set(actual).size !== testIDs.size || actual.some((id) => !testIDs.has(id))) {
    throw new Error("Lite final-test ledger is incomplete, duplicated or contaminated")
  }
  return { hard: summary.hard, soft: summary.soft, n: summary.n_items, hardCount: lines.reduce((n, line) => n + Number((JSON.parse(line) as { hard?: number }).hard === 1), 0) }
}

async function main() {
  const auditOnly = process.argv.includes("--audit-only")
  const run = process.argv.includes("--run")
  if (!auditOnly && !run) throw new Error("Specify --audit-only or --run; paid work is never implicit")
  const materialManifest = await readJsonFile<{ splitCounts: Record<string, number>; splitHashes: Record<string, string> }>(path.join(materialRoot, "materialization-manifest.json"))
  const previous = await readJsonFile<{ sourcePackages: Source[]; sourceCount: number; sourceDigest: string }>(sourceManifest)
  if (materialManifest.splitCounts.train !== 50 || materialManifest.splitCounts.val !== 24 || materialManifest.splitCounts.test !== 172) throw new Error("Unexpected clean50 split counts")
  const train = await splitIDs("train")
  const val = await splitIDs("val")
  const test = await splitIDs("test")
  if ([...train].some((id) => val.has(id) || test.has(id)) || [...val].some((id) => test.has(id))) throw new Error("Train/val/test UID overlap")
  if (previous.sourceCount !== 42 || previous.sourcePackages.length !== 42) throw new Error("Expected exactly 42 accepted source Skills")
  for (const source of previous.sourcePackages) {
    if (!train.has(source.id) || test.has(source.id)) throw new Error(`Source UID is not clean train-only: ${source.id}`)
    if ((await digestDirectory(source.skillRoot)) !== source.packageHash) throw new Error(`Source package changed after freeze: ${source.id}`)
  }
  const currentDigest = createHash("sha256").update(previous.sourcePackages.map((row) => `${row.id}:${row.packageHash}`).join("\n")).digest("hex")
  if (currentDigest !== previous.sourceDigest) throw new Error("Source manifest digest mismatch")
  const sourceSkills = previous.sourcePackages.filter((row) => row.id !== excludedLabelConflict)
  if (sourceSkills.length !== 41) throw new Error("Expected 41 compatible accepted Skills after excluding UID0165")
  const selectedDigest = createHash("sha256").update(sourceSkills.map((row) => `${row.id}:${row.packageHash}`).join("\n")).digest("hex")
  const loaded = await loadConfig(repoRoot)
  const config = {
    ...loaded.mergeConfig.asLite,
    enabled: true,
    outputRoot: "",
    splitDir: path.join(materialRoot, "split"),
    dataRoot: path.join(materialRoot, "docs"),
    maxSkillBytes: capBytes,
    optimizerModel: "MiniMax-M2.7",
    workers: 3,
    rounds: 3,
    gateMetric: "hard" as const,
  }
  const protocol = {
    schema: "auto-evolve/officeqa-merge-as-lite-clean50/v1",
    sourceManifest, frozenSourceDigest: currentDigest, selectedSourceDigest: selectedDigest,
    selectedSourceCount: sourceSkills.length, excludedLabelConflict, materialRoot,
    splitHashes: materialManifest.splitHashes, trainCount: train.size, valCount: val.size, testCount: test.size,
    producer: "MiniMax-M2.7", optimizer: "MiniMax-M2.7", tester: "MiniMax-M2.7",
    maxSkillBytes: capBytes, rounds: 3, workers: 3, gateMetric: "hard",
    implementation: "AEV-verified-source-Skills plus Lite gate adapter, not native Copilot Lite",
  }
  if (auditOnly) {
    console.log(JSON.stringify({ auditOnly: true, protocol }))
    return
  }
  await mkdir(out, { recursive: true })
  const protocolPath = path.join(out, "protocol.json")
  if (await pathExists(protocolPath)) {
    const old = await readJsonFile<typeof protocol>(protocolPath)
    if (JSON.stringify(old) !== JSON.stringify(protocol)) throw new Error("Existing run protocol differs; refusing overwrite")
  } else await writeJsonFile(protocolPath, protocol)
  const mergeRoot = path.join(out, "merge")
  const reportPath = path.join(mergeRoot, "report.json")
  let mergedSkillDir: string
  if (await pathExists(reportPath)) {
    const report = await readJsonFile<{ mergedSkillDir: string }>(reportPath)
    mergedSkillDir = report.mergedSkillDir
    if (!(await pathExists(path.join(mergedSkillDir, "CORE.md")))) throw new Error("Existing merge report has no deployable Skill")
  } else {
    const result = await runLiteMerger({
      cwd: repoRoot, runRoot: mergeRoot, config,
      sourceSkills: sourceSkills.map(({ id, skillRoot }) => ({ id, skillRoot })),
    })
    mergedSkillDir = result.mergedSkillDir
  }
  const skillPath = path.join(mergedSkillDir, "CORE.md")
  if ((await readFile(skillPath)).length > capBytes) throw new Error("Merged Skill exceeds hard byte cap")
  const testResult = await evaluateTest(skillPath, config.authFile, config.pythonCommand, config.runtimeRoot)
  await writeJsonFile(path.join(out, "completion.json"), { completedAt: new Date().toISOString(), protocol, mergedSkillDir, testResult })
  console.log(JSON.stringify({ ok: true, out, testResult }))
}

await main()
