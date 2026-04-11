import path from "node:path"
import { readdir } from "node:fs/promises"
import { autoEvolvePath, pathExists, readTextFile } from "../fs"
import type { AutoEvolveConfig } from "../schema"

export interface KnowledgeMaintenanceOpDefinition {
  id: string
  title: string
  summary: string
  notes?: string[]
  source?: "builtin" | "project"
  promptPath?: string
}

const BUILTIN_MAINTENANCE_OPS: KnowledgeMaintenanceOpDefinition[] = [
  {
    id: "inspect_workspace",
    title: "Inspect Workspace",
    summary: "Read the experience workspace entry and inspect the most relevant downstream Markdown modules.",
  },
  {
    id: "inspect_templates",
    title: "Inspect Templates",
    summary: "Inspect the reference template library for structural ideas without copying it mechanically.",
  },
  {
    id: "inspect_failure_context",
    title: "Inspect Failure Context",
    summary: "Read expected output, actual output, evaluation, and other task-context files before making changes.",
  },
  {
    id: "inspect_session_records",
    title: "Inspect Session Records",
    summary: "Read session execution reports and related run records to understand real prior behavior.",
  },
  {
    id: "rewrite_module",
    title: "Rewrite Module",
    summary: "Revise an existing Markdown module in place.",
  },
  {
    id: "create_module",
    title: "Create Module",
    summary: "Add a new Markdown module when the experience structure truly needs one.",
  },
  {
    id: "append_to_existing_module",
    title: "Append To Existing Module",
    summary: "Append a focused addendum to an existing Markdown module without rewriting its main body.",
  },
  {
    id: "create_helper_asset",
    title: "Create Helper Asset",
    summary:
      "Create a workspace-local helper asset under tools/ or skills/ when a future solve agent would benefit from a reusable local script or skill bundle.",
    notes: [
      "Keep helper assets inside tools/ or skills/ only.",
      "Prefer small text-based assets such as SKILL.md, Python scripts, and JSON manifests.",
    ],
  },
  {
    id: "update_helper_asset",
    title: "Update Helper Asset",
    summary:
      "Revise an existing workspace-local helper asset under tools/ or skills/ without breaking its discoverability from the workspace entry.",
    notes: [
      "If a helper asset changes, update the entry navigation or related tool guide when needed.",
    ],
  },
  {
    id: "split_module",
    title: "Split Module",
    summary: "Split an overloaded Markdown module into smaller modules when selective reading would improve.",
  },
  {
    id: "merge_modules",
    title: "Merge Modules",
    summary: "Merge duplicate or overlapping modules to keep the workspace coherent.",
  },
  {
    id: "deprecate_module",
    title: "Deprecate Module",
    summary: "Mark a module as deprecated when it should no longer drive future solve behavior.",
  },
  {
    id: "create_partition",
    title: "Create Partition",
    summary: "Create or extend a navigable partition when the workspace becomes large enough to justify one.",
  },
  {
    id: "rewrite_entry_navigation",
    title: "Rewrite Entry Navigation",
    summary: "Update the single workspace entry so a blank future solve agent knows what to read first.",
  },
  {
    id: "add_tool_guide",
    title: "Add Tool Guide",
    summary: "Add or refine task-specific tool usage guidance for future solve agents.",
  },
  {
    id: "add_failure_lesson",
    title: "Add Failure Lesson",
    summary: "Record a durable failure lesson that future agents should avoid repeating.",
  },
  {
    id: "record_change",
    title: "Record Change",
    summary: "Update the change log so the experience evolution remains understandable.",
  },
]

function deriveTitleFromMarkdown(id: string, content: string) {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "))
  return heading ? heading.replace(/^#\s+/, "").trim() : id
}

function deriveSummaryFromMarkdown(content: string) {
  const lines = content.split(/\r?\n/).map((line) => line.trim())
  const summaryLine = lines.find((line) => /^summary:/i.test(line))
  if (summaryLine) return summaryLine.replace(/^summary:\s*/i, "").trim()

  const paragraph = lines.find(
    (line) =>
      line.length > 0 &&
      !line.startsWith("#") &&
      !line.startsWith("-") &&
      !line.startsWith("<!--"),
  )
  return paragraph ?? "Project-defined maintenance operation."
}

function deriveNotesFromMarkdown(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
}

async function loadProjectMaintenanceOps(cwd: string, config: AutoEvolveConfig) {
  const root = autoEvolvePath(cwd, config.maintenanceOpsDir)
  if (!(await pathExists(root))) return []

  const entries = await readdir(root, { withFileTypes: true })
  const results: KnowledgeMaintenanceOpDefinition[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue
    const promptPath = path.join(root, entry.name)
    const content = await readTextFile(promptPath)
    const id = path.basename(entry.name, ".md")
    results.push({
      id,
      title: deriveTitleFromMarkdown(id, content),
      summary: deriveSummaryFromMarkdown(content),
      notes: deriveNotesFromMarkdown(content),
      source: "project",
      promptPath,
    })
  }

  return results
}

async function loadAllMaintenanceOps(cwd: string, config: AutoEvolveConfig) {
  const map = new Map(
    BUILTIN_MAINTENANCE_OPS.map((item) => [
      item.id,
      {
        ...item,
        source: "builtin" as const,
      },
    ]),
  )

  for (const item of await loadProjectMaintenanceOps(cwd, config)) {
    map.set(item.id, item)
  }

  return [...map.values()]
}

export async function listKnowledgeMaintenanceOps(cwd: string, config: AutoEvolveConfig) {
  return loadAllMaintenanceOps(cwd, config)
}

export async function resolveKnowledgeMaintenanceOps(
  cwd: string,
  config: AutoEvolveConfig,
  operationIDs?: string[],
) {
  const available = await loadAllMaintenanceOps(cwd, config)
  if (!operationIDs?.length) return available

  const index = new Map(available.map((item) => [item.id, item]))
  return operationIDs.map((id) => {
    const found = index.get(id)
    if (!found) {
      throw new Error(`Unknown knowledge maintenance operation: ${id}`)
    }
    return found
  })
}
