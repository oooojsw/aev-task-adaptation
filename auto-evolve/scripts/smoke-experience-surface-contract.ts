import path from "node:path"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  EXPERIENCE_SURFACE_CONTRACT_FILE,
  experienceWorkspacePathsFromRoot,
  resolveExperienceWorkspaceLayout,
  validateExperienceWorkspaceLayout,
} from "../orchestrator/experience-workspace"

async function writeWorkspaceFiles(root: string, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }
}

async function runScenario(input: {
  name: string
  files: Record<string, string>
  profile?: "operational" | "governed" | "auto"
}) {
  const root = await mkdtemp(path.join(tmpdir(), `auto-evolve-surface-${input.name}-`))
  try {
    await writeWorkspaceFiles(root, input.files)
    const layout = await resolveExperienceWorkspaceLayout(experienceWorkspacePathsFromRoot(root, "manifest.md"))
    const validation = validateExperienceWorkspaceLayout(layout, { profile: input.profile ?? "auto" })
    return {
      root,
      layout,
      validation,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

async function main() {
  const legacy = await runScenario({
    name: "legacy-governed",
    profile: "governed",
    files: {
      "manifest.md": "<!-- auto-evolve-entry: true -->\n<!-- auto-evolve-role: entry -->\n# Entry\n",
      "change_log.md": "<!-- auto-evolve-role: change_log -->\n# Change Log\n",
      "rules.md": "<!-- auto-evolve-role: rule_module -->\n# Rules\n",
      "tools/helper.py": "print('ok')\n",
      ".opencode/test_records.md": "sidecar\n",
    },
  })
  assert(legacy.validation.valid, `legacy-governed should pass: ${legacy.validation.errors.join(" | ")}`)

  const operational = await runScenario({
    name: "contract-operational",
    profile: "auto",
    files: {
      "manifest.md": "# Entry\n",
      "generation_procedure.md": "# Procedure\n",
      [EXPERIENCE_SURFACE_CONTRACT_FILE]: JSON.stringify(
        {
          version: 1,
          profile: "operational",
          entry: "manifest.md",
          documents: [
            { path: "manifest.md", role: "entry" },
            { path: "generation_procedure.md", role: "execution_checklist" },
          ],
          assetRoots: ["tools", "skills"],
          runtimeSidecarRoots: [".opencode"],
        },
        null,
        2,
      ),
    },
  })
  assert(operational.validation.valid, `contract-operational should pass: ${operational.validation.errors.join(" | ")}`)
  assert(
    operational.validation.warnings.some((item) => item.includes("change-log")),
    "contract-operational should warn about missing change log",
  )

  const governed = await runScenario({
    name: "contract-governed",
    profile: "auto",
    files: {
      "manifest.md": "# Entry\n",
      "change_log.md": "# Change Log\n",
      "generation_procedure.md": "# Procedure\n",
      [EXPERIENCE_SURFACE_CONTRACT_FILE]: JSON.stringify(
        {
          version: 1,
          profile: "governed",
          entry: "manifest.md",
          changeLog: "change_log.md",
          documents: [
            { path: "manifest.md", role: "entry" },
            { path: "change_log.md", role: "change_log" },
            { path: "generation_procedure.md", role: "execution_checklist" },
          ],
        },
        null,
        2,
      ),
    },
  })
  assert(governed.validation.valid, `contract-governed should pass: ${governed.validation.errors.join(" | ")}`)

  console.log(
    JSON.stringify(
      {
        passed: true,
        summary: "Expert surface contract smoke passed.",
        scenarios: {
          legacy_governed: {
            profile: legacy.validation.profile,
            warnings: legacy.validation.warnings.length,
          },
          contract_operational: {
            profile: operational.validation.profile,
            warnings: operational.validation.warnings,
          },
          contract_governed: {
            profile: governed.validation.profile,
            warnings: governed.validation.warnings.length,
          },
        },
      },
      null,
      2,
    ),
  )
}

await main()
