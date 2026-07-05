import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import {
  assertNoOracleLeakageInBlankAgentChannel,
  collectExpertOracleReadPaths,
  writeExpertOracleBundle,
} from "../orchestrator/long-task-campaign/expert-oracle-evidence"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const root = path.resolve(process.cwd(), "auto-evolve", ".tmp-smoke", "expert-oracle-bundle")
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })

const answerPath = path.join(root, "private-answers", "case-001", "answer.xlsx")
const missingAnswerPath = path.join(root, "private-answers", "case-001", "missing-answer.xlsx")
await mkdir(path.dirname(answerPath), { recursive: true })
await writeFile(answerPath, "fake-answer")

const viewPath = path.join(root, "validators", "product", "result.private.json")
await mkdir(path.dirname(viewPath), { recursive: true })
await writeFile(
  viewPath,
  JSON.stringify(
    {
      raw: {
        command: ["python", "validate.py", "--answer", answerPath, "--candidate", "workspace/answer.json"],
        payload: {
          files: {
            answer_path: answerPath,
            missing_answer_path: missingAnswerPath,
            plain_text: "this is a normal sentence mentioning answer but not a path",
          },
        },
      },
    },
    null,
    2,
  ),
)

const oracle = await collectExpertOracleReadPaths({
  validatorResults: [
    {
      validatorID: "product",
      passed: false,
      evidenceRefs: [viewPath],
    },
  ],
})

const normalized = oracle.paths.map((item) => item.replace(/\\/g, "/").toLowerCase())
assert(normalized.some((item) => item.endsWith("/result.private.json")), "result.private.json was not collected")
assert(normalized.some((item) => item.endsWith("/private-answers/case-001/answer.xlsx")), "embedded private answer file was not collected")
assert(!normalized.some((item) => item.endsWith("/private-answers")), "directory-level private-answers path must not be collected")
assert(!normalized.some((item) => item.endsWith("/missing-answer.xlsx")), "non-existent embedded oracle file must not be collected")

let blankLeakBlocked = false
try {
  assertNoOracleLeakageInBlankAgentChannel([answerPath], "smoke blank evidence")
} catch {
  blankLeakBlocked = true
}
assert(blankLeakBlocked, "blank-agent evidence channel must reject private answer paths")

const bundlePath = path.join(root, "expert-oracle-bundle.json")
const written = await writeExpertOracleBundle({
  outPath: bundlePath,
  campaignID: "smoke",
  roundNumber: 1,
  passID: "pass-01",
  resultPath: viewPath,
  oracle,
})

assert(written.bundle.blankAgentPolicy === "never_expose_to_blank_agent", "bundle blank-agent policy is missing")
assert(written.bundle.oraclePaths.length >= 2, "bundle did not include collected oracle paths")
console.log(JSON.stringify({ ok: true, bundlePath, oraclePaths: written.bundle.oraclePaths.length }, null, 2))
