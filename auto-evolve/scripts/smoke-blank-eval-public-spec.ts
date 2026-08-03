import { buildBlankEvalPublicTaskSpec } from "../orchestrator/blank-eval/runner"
import type { LongTaskSpec } from "../orchestrator/long-task/contract"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const spec: LongTaskSpec = {
  id: "spreadsheet-public-spec-smoke",
  title: "Spreadsheet public spec smoke",
  goal: "Write the requested spreadsheet answer.",
  taskFamily: "spreadsheetbench",
  domainTags: ["spreadsheet"],
  materials: [
    { path: "sandbox/materials/01-instruction.md", label: "instruction", role: "instruction" },
    { path: "sandbox/materials/02-input.xlsx", label: "input workbook", role: "source-workbook" },
  ],
  targetPaths: [{ path: "sandbox/workspace/answer.json", label: "answer", role: "candidate-output" }],
  editablePaths: ["sandbox/workspace"],
  validators: [
    {
      id: "spreadsheet-hard-validate",
      type: "script",
      title: "Spreadsheet hard validate",
      path: "scripts/validate-spreadsheetbench-answer.py",
      runner: "python",
      placement: "completion_only",
      required: true,
      args: [
        "--answer",
        "../../private-answers/30930/answer.xlsx",
        "--candidate",
        "./workspace/answer.json",
        "--range",
        "C2:C66",
        "--tolerance",
        "0.01",
      ],
      validation: {
        target: "product",
        stage: "post_blank",
        answerAccess: "private_oracle",
      },
    },
  ],
}

const publicSpec = buildBlankEvalPublicTaskSpec(spec)
const text = JSON.stringify(publicSpec, null, 2)
const scriptValidator = publicSpec.validators.find((item) => item.id === "spreadsheet-hard-validate")
const contract = scriptValidator?.publicOutputContract as Record<string, unknown> | undefined

assert(text.includes("C2:C66"), "public spec should preserve the public output range")
assert(contract?.candidate === "./workspace/answer.json", "public spec should preserve the validator candidate output path")
assert(!text.toLowerCase().includes("private-answers"), "public spec must not leak private answer directory")
assert(!text.toLowerCase().includes("answer.xlsx"), "public spec must not leak answer workbook filename")
assert(!text.toLowerCase().includes("--answer"), "public spec must not leak private answer flag")
assert(!text.toLowerCase().includes("ground-truth"), "public spec must not leak ground truth markers")

console.log("smoke-blank-eval-public-spec passed")
