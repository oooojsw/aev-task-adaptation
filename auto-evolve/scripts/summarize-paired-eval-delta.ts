import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { ensureDirectory } from "../orchestrator/fs"

type EvalRow = { id?: unknown; hard?: unknown; soft?: unknown; fail_reason?: unknown; response?: unknown; predicted_answer?: unknown }
type LoadedRow = { id: string; hard: number; soft: number; failReason: string; line: number }

function usage(): never {
  throw new Error(
    "Usage: bun run auto-evolve/scripts/summarize-paired-eval-delta.ts --baseline <results.jsonl> --condition <results.jsonl> --out-dir <dir> [--label <text>]",
  )
}

function option(argv: string[], key: string) {
  const index = argv.indexOf(key)
  return index >= 0 ? argv[index + 1] : undefined
}

async function loadRows(filePath: string) {
  const rows = new Map<string, LoadedRow>()
  const lines = (await readFile(filePath, "utf8")).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue
    const raw = JSON.parse(lines[index]) as EvalRow
    const id = String(raw.id ?? "").trim()
    if (!id) throw new Error(`Missing id in ${filePath}:${index + 1}`)
    if (rows.has(id)) throw new Error(`Duplicate id ${id} in ${filePath}`)
    const hard = Number(raw.hard)
    const soft = Number(raw.soft)
    if (!Number.isFinite(hard) || !Number.isFinite(soft)) throw new Error(`Missing hard/soft score for ${id} in ${filePath}:${index + 1}`)
    rows.set(id, { id, hard, soft, failReason: String(raw.fail_reason ?? ""), line: index + 1 })
  }
  if (!rows.size) throw new Error(`No result rows in ${filePath}`)
  return rows
}

function csv(value: string | number) {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function main() {
  const argv = process.argv.slice(2)
  const baselinePath = option(argv, "--baseline")
  const conditionPath = option(argv, "--condition")
  const outDir = option(argv, "--out-dir")
  const label = option(argv, "--label") || "paired-evaluation"
  if (!baselinePath || !conditionPath || !outDir) usage()
  const baselineFile = path.resolve(baselinePath)
  const conditionFile = path.resolve(conditionPath)
  const baseline = await loadRows(baselineFile)
  const condition = await loadRows(conditionFile)
  const missingInCondition = [...baseline.keys()].filter((id) => !condition.has(id)).sort()
  const missingInBaseline = [...condition.keys()].filter((id) => !baseline.has(id)).sort()
  if (missingInCondition.length || missingInBaseline.length) {
    throw new Error(`UID sets differ: missingInCondition=${missingInCondition.join(",")}; missingInBaseline=${missingInBaseline.join(",")}`)
  }
  const rows = [...baseline.keys()].sort().map((id) => {
    const before = baseline.get(id)!
    const after = condition.get(id)!
    const beforePass = before.hard > 0
    const afterPass = after.hard > 0
    const category = !beforePass && afterPass ? "gain" : beforePass && !afterPass ? "regression" : beforePass ? "both_pass" : "both_fail"
    return {
      id,
      category,
      baselineHard: before.hard,
      conditionHard: after.hard,
      baselineSoft: before.soft,
      conditionSoft: after.soft,
      softDelta: after.soft - before.soft,
      baselineFailReason: before.failReason,
      conditionFailReason: after.failReason,
      baselineEvidence: `${baselineFile}:${before.line}`,
      conditionEvidence: `${conditionFile}:${after.line}`,
    }
  })
  const counts = Object.fromEntries(["gain", "regression", "both_pass", "both_fail"].map((key) => [key, rows.filter((row) => row.category === key).length])) as Record<string, number>
  const summary = {
    schema: "auto-evolve/paired-eval-delta/v1",
    label,
    baselinePath: baselineFile,
    conditionPath: conditionFile,
    denominator: rows.length,
    counts,
    hardDelta: rows.reduce((sum, row) => sum + row.conditionHard - row.baselineHard, 0),
    meanSoftDelta: rows.reduce((sum, row) => sum + row.softDelta, 0) / rows.length,
    invariant: "UID sets are identical, unique, and every row has finite hard/soft scores.",
  }
  const target = path.resolve(outDir)
  await ensureDirectory(target)
  await writeFile(path.join(target, "paired-delta-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  await writeFile(path.join(target, "paired-delta-cases.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8")
  const csvLines = ["id,category,baseline_hard,condition_hard,baseline_soft,condition_soft,soft_delta,baseline_evidence,condition_evidence"]
  for (const row of rows) csvLines.push([row.id, row.category, row.baselineHard, row.conditionHard, row.baselineSoft, row.conditionSoft, row.softDelta, row.baselineEvidence, row.conditionEvidence].map(csv).join(","))
  await writeFile(path.join(target, "paired-delta-cases.csv"), `${csvLines.join("\n")}\n`, "utf8")
  const examples = (category: string) => rows.filter((row) => row.category === category).slice(0, 10).map((row) => `- ${row.id}: ${row.conditionEvidence}`).join("\n") || "- none"
  const markdown = [
    `# ${label}: Paired UID Delta`,
    "",
    `- Denominator: ${rows.length} exact, unique shared UIDs`,
    `- Hard-score delta: ${summary.hardDelta >= 0 ? "+" : ""}${summary.hardDelta}`,
    `- Mean soft-score delta: ${summary.meanSoftDelta.toFixed(6)}`,
    "",
    "| Category | Count | Meaning |",
    "| --- | ---: | --- |",
    `| gain | ${counts.gain} | baseline failed, condition passed |`,
    `| regression | ${counts.regression} | baseline passed, condition failed |`,
    `| both_pass | ${counts.both_pass} | both passed |`,
    `| both_fail | ${counts.both_fail} | both failed |`,
    "",
    "## Gain examples",
    examples("gain"),
    "",
    "## Regression examples",
    examples("regression"),
    "",
    "Raw per-UID classifications and evidence line references are in `paired-delta-cases.json` and `paired-delta-cases.csv`.",
  ].join("\n")
  await writeFile(path.join(target, "paired-delta-report.md"), `${markdown}\n`, "utf8")
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
