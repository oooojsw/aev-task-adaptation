import { loadConfig } from "../orchestrator/schema"
import { runOpencodeTask } from "../orchestrator/opencode"

async function main() {
  const cwd = process.cwd()
  const config = await loadConfig(cwd)
  const defaultModel = config.modelConfig.defaults.model ?? config.defaultModel
  if (!defaultModel) throw new Error("No default OpenCode model configured.")

  const [providerID, modelID] = defaultModel.split("/")
  if (!providerID || !modelID) {
    throw new Error(`Default OpenCode model must use provider/model format: ${defaultModel}`)
  }

  const negative = await runOpencodeTask({
    cwd,
    config,
    title: "Smoke Missing Model Must Not Fallback",
    prompt: "This prompt must never reach an OpenCode model.",
    model: "missing-provider/MissingModel",
    permissionReadPaths: [],
    permissionEditPaths: [],
    runtimeScope: "smoke-model-resolution-negative",
    recordAdaptiveConcurrency: false,
  })

  if (negative.result.exitCode === 0) {
    throw new Error("Expected missing model to fail before OpenCode spawn, but it succeeded.")
  }
  if (!negative.result.stderr.includes("Requested OpenCode model is not resolvable")) {
    throw new Error(`Missing model failed for the wrong reason:\n${negative.result.stderr}`)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        defaultModel,
        providerID,
        modelID,
        negativeFallbackBlocked: true,
      },
      null,
      2,
    ),
  )
}

await main()
