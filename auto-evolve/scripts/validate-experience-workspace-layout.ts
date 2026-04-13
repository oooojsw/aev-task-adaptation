import path from "node:path"
import { loadConfig } from "../orchestrator/schema"
import {
  experienceWorkspacePathsFromRoot,
  resolveExperienceWorkspaceLayout,
  validateExperienceWorkspaceLayout,
} from "../orchestrator/experience-workspace"
import { readJsonFile, pathExists } from "../orchestrator/fs"

function print(result: Record<string, unknown>, exitCode: number) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(exitCode)
}

function resolveWorkspaceRoot(candidate: string) {
  const resolved = path.resolve(candidate)
  if (resolved.toLowerCase().endsWith(".md")) {
    return path.dirname(resolved)
  }
  return resolved
}

async function main() {
  const [, , payloadPath, explicitWorkspacePath, explicitProfile] = Bun.argv
  if (!payloadPath) {
    print(
      {
        passed: false,
        summary: "Missing validator input path.",
        details: ["Expected validator_input.json as argv[2]."],
        blocking: true,
      },
      1,
    )
  }

  const payload = await readJsonFile<Record<string, unknown>>(path.resolve(payloadPath))
  const fallbackTargetPath =
    Array.isArray(payload.targetPaths) && payload.targetPaths.length > 0
      ? payload.targetPaths
          .map((item) => (typeof item === "object" && item && "path" in item ? item.path : undefined))
          .find((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined
  const workspacePath = explicitWorkspacePath ?? fallbackTargetPath

  if (!workspacePath) {
    print(
      {
        passed: false,
        summary: "Could not infer workspace root.",
        details: ["Pass an explicit workspace path or include a targetPaths entry that points to the experience workspace."],
        blocking: true,
      },
      1,
    )
  }

  const workspaceRoot = resolveWorkspaceRoot(workspacePath)
  if (!(await pathExists(workspaceRoot))) {
    print(
      {
        passed: false,
        summary: "Experience workspace root does not exist yet.",
        details: [workspaceRoot],
        blocking: false,
      },
      1,
    )
  }

  const config = await loadConfig(process.cwd())
  const layout = await resolveExperienceWorkspaceLayout(
    experienceWorkspacePathsFromRoot(workspaceRoot, config.experienceEntryFile),
  )
  const validation = validateExperienceWorkspaceLayout(layout, {
    profile: explicitProfile === "operational" || explicitProfile === "governed" ? explicitProfile : "auto",
  })

  print(
    {
      passed: validation.valid,
      summary: validation.valid
        ? `Expert surface is valid under the ${validation.profile} profile.`
        : `Expert surface is invalid under the ${validation.profile} profile.`,
      details: validation.valid
        ? [
            `entry: ${layout.entryRelativePath}`,
            `documents: ${layout.documents.length}`,
            `assets: ${layout.assets.length}`,
            `control_files: ${layout.controlFiles.length}`,
            `runtime_sidecars: ${layout.runtimeSidecarFiles.length}`,
            `contract_present: ${validation.contractPresent}`,
          ]
        : validation.errors,
      warnings: validation.warnings,
      blocking: false,
    },
    validation.valid ? 0 : 1,
  )
}

await main()
