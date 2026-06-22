import path from "node:path"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { loadConfig } from "../orchestrator/schema"
import { runLongTaskValidator } from "../orchestrator/long-task/validators"
import type {
  LongTaskScriptValidatorContract,
  LongTaskSpec,
  LongTaskWorkUnit,
} from "../orchestrator/long-task/contract"

const cwd = path.resolve(import.meta.dir, "..", "..")
const root = await mkdtemp(path.join(tmpdir(), "auto-evolve-validator-circuit-"))
const config = await loadConfig(cwd)
const scriptsRoot = path.join(root, "scripts")
await mkdir(scriptsRoot, { recursive: true })

const cases = [
  {
    id: "product-mismatch",
    body: `import json\nprint(json.dumps({"passed": False, "blocking": True, "summary": "answer mismatch", "details": ["r1c1 mismatch"]}))\n`,
    expected: "product_failure",
  },
  {
    id: "argparse-crash",
    body: `import sys\nsys.stderr.write("usage: validator --sheet SHEET\\nvalidator: error: argument --sheet: expected one argument\\n")\nsys.exit(2)\n`,
    expected: "validator_infrastructure",
  },
  {
    id: "structured-validator-crash",
    body: `import json\nprint(json.dumps({"passed": False, "blocking": True, "summary": "Validator crashed.", "details": ["Unexpected UTF-8 BOM"]}))\n`,
    expected: "validator_infrastructure",
  },
] as const

const spec = {
  id: "validator-circuit-smoke",
  title: "Validator Circuit Smoke",
  goal: "Exercise local validator failure classification.",
  taskFamily: "smoke",
  materials: [],
  targetPaths: [],
  editablePaths: [],
  formalPackageRoots: [],
  validators: [],
  planning: { agent: "top" },
  execution: { agent: "top" },
  validation: { agent: "top" },
  initialGraph: { plannerSummary: "smoke", completionValidatorIDs: [], units: [] },
  budgets: {
    maxAttemptsPerUnit: 1,
    maxTotalUnitAttempts: 1,
    maxGraphReplans: 0,
    maxValidatorCalls: 3,
    maxNoProgressCycles: 1,
    maxUnitsPerGraph: 1,
  },
} as unknown as LongTaskSpec

const unit = {
  id: "smoke-unit",
  title: "Smoke Unit",
  goal: spec.goal,
  inputs: [],
  dependsOn: [],
  expectedArtifacts: [],
  claim: "smoke",
  checkPlan: "smoke",
  validatorIDs: cases.map((item) => item.id),
  retryBudget: 0,
  status: "active",
  attemptCount: 1,
} satisfies LongTaskWorkUnit

const results = []
for (const item of cases) {
  const scriptPath = path.join(scriptsRoot, `${item.id}.py`)
  await writeFile(scriptPath, item.body, "utf8")
  const contract = {
    id: item.id,
    type: "script",
    title: item.id,
    path: scriptPath,
    runner: "python",
    placement: "completion_only",
    required: true,
    blocking: true,
    args: [],
    timeoutMs: 10_000,
  } satisfies LongTaskScriptValidatorContract
  const result = await runLongTaskValidator({
    cwd,
    config,
    contract,
    spec,
    unit,
    runID: "validator-circuit-smoke",
    attempt: 1,
    validatorDir: path.join(root, "results", item.id),
    bundlePath: path.join(root, "bundle.json"),
    payload: {},
  })
  results.push({
    id: item.id,
    expected: item.expected,
    actual: result.failureKind,
    passed: result.failureKind === item.expected,
    summary: result.summary,
  })
}

const failed = results.filter((item) => !item.passed)
console.log(JSON.stringify({ passed: failed.length === 0, results, root }, null, 2))
if (failed.length) process.exitCode = 1
