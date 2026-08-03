import path from "node:path"
import { loadConfig } from "../orchestrator/schema"
import {
  buildEditPermissionRules,
  runOpencodeTask,
  sanitizeCachedProviderForRuntime,
} from "../orchestrator/opencode"

async function main() {
  const sanitizedProvider = sanitizeCachedProviderForRuntime({
    id: "smoke-provider",
    name: "Smoke Provider",
    npm: "@ai-sdk/openai-compatible",
    env: ["SMOKE_API_KEY"],
    api: "http://127.0.0.1:1/v1",
    models: { "smoke-model": { id: "smoke-model", name: "Smoke Model" } },
    doc: "https://example.invalid/provider-docs",
    uiOnlyMetadata: { featured: true },
  })
  if ("doc" in sanitizedProvider || "uiOnlyMetadata" in sanitizedProvider) {
    throw new Error("Provider cache UI metadata leaked into the runtime OpenCode config.")
  }
  if (!objectRecord(sanitizedProvider.models)?.["smoke-model"]) {
    throw new Error("Provider cache sanitization removed the requested model definition.")
  }

  const cwd = process.cwd()
  const pendingEditableRoot = path.join(cwd, "auto-evolve", "runtime-state", ".smoke-pending-edit-root")
  const editRules = await buildEditPermissionRules(cwd, [pendingEditableRoot])
  const normalizedEditableRoot = pendingEditableRoot.replace(/\\/g, "/")
  if (editRules[normalizedEditableRoot] !== "allow" || editRules[`${normalizedEditableRoot}/**`] !== "allow") {
    throw new Error("A declared editable root did not grant access to artifacts created below it.")
  }
  if (editRules[path.dirname(normalizedEditableRoot)] === "allow") {
    throw new Error("Editable root permission escaped into its parent directory.")
  }

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
        providerCacheMetadataSanitized: true,
        pendingEditableRootAllowsChildren: true,
        negativeFallbackBlocked: true,
      },
      null,
      2,
    ),
  )
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

await main()
