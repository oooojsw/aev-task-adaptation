import path from "node:path"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { loadLongTaskSpec } from "../orchestrator/long-task/spec"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "aev-blank-eval-plan-spec-smoke-"))
  await mkdir(path.join(root, "materials"), { recursive: true })
  await mkdir(path.join(root, "workspace", "merged-skill"), { recursive: true })
  await writeFile(path.join(root, "materials", "task.md"), "smoke material", "utf8")
  await writeFile(path.join(root, "materials", "inline.md"), "inline prompt", "utf8")
  await writeFile(
    path.join(root, "materials", "replay-plan.json"),
    JSON.stringify(
      {
        cases: [
          {
            id: "case-a",
            specPath: "../spec.json",
            promptInlinePaths: ["./inline.md"],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  )
  const specPath = path.join(root, "spec.json")
  await writeFile(
    specPath,
    JSON.stringify(
      {
        title: "blank eval plan spec smoke",
        goal: "smoke",
        materials: [{ path: "materials/task.md", label: "task" }],
        validators: [
          {
            id: "merged-skill-replay",
            type: "blank_eval_plan",
            title: "Merged skill replay",
            placement: "completion_only",
            planPath: "materials/replay-plan.json",
            skillRootPath: "workspace/merged-skill",
            mode: "parallel",
            concurrency: 2,
            stopOnFirstFailure: true,
            successCriterion: "all_pass"
          }
        ]
      },
      null,
      2,
    ),
    "utf8",
  )
  const { spec } = await loadLongTaskSpec(specPath)
  assert(spec.validators.length === 1, "expected one validator")
  const validator = spec.validators[0]
  assert(validator.type === "blank_eval_plan", "expected blank_eval_plan validator")
  assert(path.isAbsolute(validator.planPath), "planPath should be resolved to absolute path")
  assert(path.isAbsolute(validator.skillRootPath), "skillRootPath should be resolved to absolute path")
  assert(validator.mode === "parallel", "mode should survive normalization")
  assert(validator.stopOnFirstFailure === true, "stopOnFirstFailure should survive normalization")
  console.log("smoke-blank-eval-plan-spec passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
