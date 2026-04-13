import path from "node:path"
import process from "node:process"
import {
  autoEvolvePath,
  ensureDirectory,
  writeJsonFile,
  writeTextFile,
} from "../orchestrator/fs"
import type { LongTaskOperationalContextItem, LongTaskSpec } from "../orchestrator/long-task/contract"
import {
  buildLongTaskWorkUnit,
  buildRetryInputBundle,
  createInitialLongTaskProgressState,
  initializeLongTaskRun,
  upsertOperationalContext,
} from "../orchestrator/long-task/repository"
import { createLongTaskWorkGraph, deriveLongTaskProgressState } from "../orchestrator/long-task/work-graph"

function stamp() {
  const now = new Date()
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
}

async function main() {
  const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
  const root = path.join(autoEvolvePath(cwd), "runtime-state", "long-task", "smoke-shared-context", stamp())
  const materialsDir = path.join(root, "materials")
  const workspaceRoot = path.join(root, "expert-workspace")
  const reportPath = path.join(root, "summary.json")
  const materialPath = path.join(materialsDir, "goal.txt")
  const validatorPath = path.join(autoEvolvePath(cwd), "scripts", "validate-text-target-contains.ps1")

  await ensureDirectory(materialsDir)
  await ensureDirectory(workspaceRoot)
  await writeTextFile(materialPath, "Use the promoted method and formal package root.\n")
  await writeTextFile(path.join(workspaceRoot, "manifest.md"), "# Smoke Expert Workspace\n")

  const spec: LongTaskSpec = {
    title: "Long Task Shared Context Smoke",
    goal: "Verify that run-global operational context is visible to later retry bundles.",
    taskFamily: "system_smoke",
    domainTags: ["system_smoke", "shared_context"],
    materials: [{ path: materialPath, label: "goal material" }],
    targetPaths: [{ path: workspaceRoot, label: "workspace", role: "experience-workspace" }],
    editablePaths: [workspaceRoot],
    validators: [
      {
        id: "noop",
        type: "script",
        title: "Noop validator",
        path: validatorPath,
        runner: "powershell",
        inputMode: "json_file",
        args: ["SMOKE"],
        required: false,
        blocking: false,
      },
    ],
  }

  const firstUnit = buildLongTaskWorkUnit({
    id: "discover-method",
    title: "Discover Method",
    goal: "Discover the shared method.",
    inputs: [materialPath],
    dependsOn: [],
    expectedArtifacts: [workspaceRoot],
    claim: "A stable method has been discovered.",
    checkPlan: "Promote the method into run-global operational context.",
    validatorIDs: [],
    status: "verified",
    attemptCount: 1,
  })
  const secondUnit = buildLongTaskWorkUnit({
    id: "consume-method",
    title: "Consume Method",
    goal: "Consume the promoted shared method.",
    inputs: [workspaceRoot],
    dependsOn: ["discover-method"],
    expectedArtifacts: [workspaceRoot],
    claim: "The promoted method was visible to this later unit.",
    checkPlan: "Read the retry bundle and confirm the promoted shared method is present.",
    validatorIDs: [],
    status: "planned",
    attemptCount: 0,
  })

  const graph = createLongTaskWorkGraph({
    units: [firstUnit, secondUnit],
    completionValidatorIDs: [],
    plannerSummary: "Shared-context smoke graph",
  })
  const runID = `smoke-shared-${stamp()}`
  const progress = deriveLongTaskProgressState({
    runID,
    graph,
    previous: createInitialLongTaskProgressState(runID),
    status: "running",
  })

  const initialized = await initializeLongTaskRun({
    cwd,
    spec,
    workGraph: graph,
    progressState: progress,
  })

  const promotedItem: LongTaskOperationalContextItem = {
    id: "opctx-smoke-promoted-method",
    runID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceUnitID: firstUnit.id,
    sourceAttempt: 1,
    kind: "validated_method",
    status: "confirmed",
    statement: "Use the promoted CLI path instead of rediscovering the tool entrypoint.",
    rationale: "Smoke-provided promoted run-global method.",
    refs: [materialPath],
    tags: ["system_smoke", "validated_method"],
  }
  await upsertOperationalContext(initialized.run, [promotedItem])

  const bundle = await buildRetryInputBundle({
    paths: initialized.paths,
    run: initialized.run,
    spec,
    unitID: secondUnit.id,
  })

  const summary = {
    passed:
      bundle.runGlobalOperationalContext.some((item) => item.statement === promotedItem.statement) &&
      bundle.formalPackageRoots.includes(workspaceRoot),
    runID,
    runDir: initialized.run.root,
    promotedCount: bundle.runGlobalOperationalContext.length,
    formalPackageRoots: bundle.formalPackageRoots,
    sampleOperationalContext: bundle.runGlobalOperationalContext[0] ?? null,
  }

  await writeJsonFile(reportPath, summary)
  console.log(JSON.stringify(summary, null, 2))

  if (!summary.passed) {
    throw new Error("Shared context smoke failed: promoted run-global context was not visible to the later retry bundle.")
  }
}

await main()
