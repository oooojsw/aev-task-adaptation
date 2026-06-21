import fs from "node:fs"
import path from "node:path"

function parseArgs(argv) {
  const out = { oldRuns: [], deltaRuns: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === "--old-run" && value) {
      out.oldRuns.push(path.resolve(value))
      index += 1
    } else if (key === "--delta-run" && value) {
      out.deltaRuns.push(path.resolve(value))
      index += 1
    } else if (key?.startsWith("--") && value) {
      out[key.slice(2)] = path.resolve(value)
      index += 1
    }
  }
  return out
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
}

function parseCsvLine(line) {
  const values = []
  let current = ""
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === "," && !quoted) {
      values.push(current)
      current = ""
    } else {
      current += char
    }
  }
  values.push(current)
  return values
}

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean)
  const headers = parseCsvLine(lines.shift())
  return lines.map((line) => Object.fromEntries(headers.map((header, index) => [header, parseCsvLine(line)[index] ?? ""])))
}

function walkResults(root) {
  const found = []
  if (!fs.existsSync(root)) return found
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) found.push(...walkResults(full))
    else if (entry.name === "result.json") found.push(readJson(full))
  }
  return found
}

function csvCell(value) {
  const text = String(value ?? "")
  return `"${text.replaceAll('"', '""')}"`
}

const args = parseArgs(process.argv.slice(2))
for (const required of ["target-split", "out-dir"]) {
  if (!args[required]) throw new Error(`Missing --${required}`)
}
if (!args["old-results-csv"] && args.oldRuns.length === 0) {
  throw new Error("Provide --old-results-csv or at least one --old-run")
}

const targetIDs = readJson(args["target-split"])
const targetSet = new Set(targetIDs)
const results = new Map()

if (args["old-results-csv"]) {
  for (const row of readCsv(args["old-results-csv"])) {
    if (!targetSet.has(row.caseID)) continue
    results.set(row.caseID, {
      caseID: row.caseID,
      modelID: row.modelID,
      passed: String(row.passed).toLowerCase() === "true",
      errorCategory: row.errorCategory || (String(row.passed).toLowerCase() === "true" ? "none" : "unknown"),
      answer: row.answer || "",
      sourceRun: row.sourceRun || args["old-results-csv"],
      sourceKind: "retained-old-shared",
    })
  }
}

for (const runDir of args.oldRuns) {
  for (const row of walkResults(path.join(runDir, "results"))) {
    if (!targetSet.has(row.caseID)) continue
    results.set(row.caseID, {
      caseID: row.caseID,
      modelID: row.modelID,
      passed: Boolean(row.passed),
      errorCategory: row.errorCategory || (row.passed ? "none" : "unknown"),
      answer: row.answer || "",
      sourceRun: runDir,
      sourceKind: "retained-old-shared",
    })
  }
}

for (const runDir of args.deltaRuns) {
  for (const row of walkResults(path.join(runDir, "results"))) {
    if (!targetSet.has(row.caseID)) throw new Error(`Delta run contains non-target case: ${row.caseID}`)
    results.set(row.caseID, {
      caseID: row.caseID,
      modelID: row.modelID,
      passed: Boolean(row.passed),
      errorCategory: row.errorCategory || (row.passed ? "none" : "unknown"),
      answer: row.answer || "",
      sourceRun: runDir,
      sourceKind: "new-delta-or-retry",
    })
  }
}

const ordered = targetIDs.map((caseID) => results.get(caseID))
const missing = targetIDs.filter((caseID) => !results.has(caseID))
if (missing.length) throw new Error(`Missing ${missing.length} target cases: ${missing.join(", ")}`)
if (ordered.length !== 172) throw new Error(`Expected 172 results, got ${ordered.length}`)

const transient = ordered.filter((row) =>
  ["rate_limit", "timeout", "network", "api_error", "bad_request"].includes(row.errorCategory),
)
if (transient.length) throw new Error(`Transient failures remain: ${transient.map((row) => row.caseID).join(", ")}`)

const passed = ordered.filter((row) => row.passed).length
const categories = Object.fromEntries(
  [...new Set(ordered.map((row) => row.errorCategory))]
    .sort()
    .map((category) => [category, ordered.filter((row) => row.errorCategory === category).length]),
)
const sourceKinds = Object.fromEntries(
  [...new Set(ordered.map((row) => row.sourceKind))]
    .sort()
    .map((kind) => [kind, ordered.filter((row) => row.sourceKind === kind).length]),
)

fs.mkdirSync(args["out-dir"], { recursive: true })
const headers = ["caseID", "modelID", "passed", "errorCategory", "answer", "sourceRun", "sourceKind"]
const csv = [
  headers.map(csvCell).join(","),
  ...ordered.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
].join("\n") + "\n"
fs.writeFileSync(path.join(args["out-dir"], "results.csv"), csv, "utf8")

const summary = {
  schema: "direct-chat-delta-aggregate/v1",
  modelID: ordered[0]?.modelID || "",
  total: ordered.length,
  passed,
  failed: ordered.length - passed,
  accuracy: passed / ordered.length,
  targetSplit: args["target-split"],
  retainedOldResultsCsv: args["old-results-csv"] || null,
  retainedOldRuns: args.oldRuns,
  deltaRuns: args.deltaRuns,
  sourceKinds,
  errorCategories: categories,
  createdAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(args["out-dir"], "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8")
fs.writeFileSync(
  path.join(args["out-dir"], "summary.md"),
  [
    "# Direct Chat Delta Aggregate",
    "",
    `- Model: ${summary.modelID}`,
    `- Total: ${summary.total}`,
    `- Passed: ${summary.passed}`,
    `- Failed: ${summary.failed}`,
    `- Accuracy: ${(summary.accuracy * 100).toFixed(4)}%`,
    `- Retained old shared cases: ${sourceKinds["retained-old-shared"] || 0}`,
    `- New delta cases: ${sourceKinds["new-delta-or-retry"] || 0}`,
    "",
  ].join("\n"),
  "utf8",
)
console.log(JSON.stringify(summary, null, 2))
