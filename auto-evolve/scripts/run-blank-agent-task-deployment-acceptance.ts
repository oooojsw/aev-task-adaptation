import path from "node:path"
import { runBlankAgentSingleSessionTaskAcceptance, readValidatorPayload } from "../orchestrator/acceptance-framework/task"

function fail(summary: string, details: string[] = [], blocking = true) {
  console.log(
    JSON.stringify(
      {
        passed: false,
        summary,
        details,
        blocking,
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

async function main() {
  const [, , payloadPath, deploymentSpecPath, ...formalSurfaceRoots] = Bun.argv
  if (!payloadPath || !deploymentSpecPath) {
    fail(
      "Missing required arguments.",
      [
        "Usage: bun run auto-evolve/scripts/run-blank-agent-task-deployment-acceptance.ts <validator-input.json> <deployment-spec.json> [formal-surface-root ...]",
      ],
    )
  }

  try {
    const payload = await readValidatorPayload(path.resolve(payloadPath))
    const sourceRunID =
      typeof payload.runID === "string" && payload.runID.trim().length > 0
        ? payload.runID
        : `deployment-source-${Date.now()}`
    const targetID =
      typeof payload.unitID === "string" && payload.unitID.trim().length > 0
        ? `deployment:${payload.unitID}`
        : `deployment:${path.basename(deploymentSpecPath)}`

    const resolvedFormalSurfaceRoots =
      formalSurfaceRoots.length > 0
        ? formalSurfaceRoots.map((item) => path.resolve(item))
        : Array.isArray(payload.targetPaths)
          ? payload.targetPaths
              .map((item) => (typeof item === "object" && item && "path" in item ? item.path : undefined))
              .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              .map((item) => path.resolve(item))
          : []

    if (!resolvedFormalSurfaceRoots.length) {
      fail("No formal expert surface root was provided for deployment acceptance.", [
        "Pass one or more formal surface roots explicitly, or ensure the validator payload targetPaths point at the learned expert surface.",
      ])
    }

    const result = await runBlankAgentSingleSessionTaskAcceptance({
      cwd: process.cwd(),
      sourceRunID,
      targetKind: "deployment_run",
      targetID,
      deploymentSpecPath: path.resolve(deploymentSpecPath),
      formalSurfaceRoots: resolvedFormalSurfaceRoots,
      harnessRoot: path.join(process.cwd(), "auto-evolve", "runtime-state", "acceptance-framework", "deployment-runs"),
      policyID: "blank-agent-single-session-task-gate",
    })

    console.log(
      JSON.stringify(
        {
          passed: result.passed,
          summary: result.summary,
          details: result.validatorResults.map((item) => `${item.validatorID}: ${item.summary}`),
          blocking: !result.passed,
          runDir: result.runDir,
          acceptanceRecordPath: result.acceptanceRecordPath,
        },
        null,
        2,
      ),
    )

    if (!result.passed) {
      process.exit(1)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail("Blank-agent task deployment acceptance crashed.", [message])
  }
}

await main()
