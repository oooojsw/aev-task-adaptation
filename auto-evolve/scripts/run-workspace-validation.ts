import {
  resolveExperienceWorkspaceLayout,
  validateExperienceWorkspaceLayout,
  experienceWorkspacePathsFromRoot,
} from "../orchestrator/experience-workspace.ts"
import { loadConfig } from "../orchestrator/schema"

const workspacePath =
  "C:\\Users\\ZhuanZ\\Desktop\\opencode re\\opencode latest\\auto-evolve\\task-packs\\real-long-tasks\\try4-expert-bootstrap\\expert-workspace"
const config = await loadConfig(process.cwd())
const paths = experienceWorkspacePathsFromRoot(workspacePath, config.experienceEntryFile)
const layout = await resolveExperienceWorkspaceLayout(paths)
const validation = validateExperienceWorkspaceLayout(layout, { profile: "governed" })
console.log(
  JSON.stringify(
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
    null,
    2,
  ),
)
process.exit(validation.valid ? 0 : 1)
