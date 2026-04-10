import path from "node:path"
import type { CaseSpec, LoadedCase } from "./schema"
import type { AutoEvolveConfig } from "./schema"
import {
  type ExperienceWorkspaceLayout,
  type TemplateLibraryPaths,
} from "./experience-workspace"
import { autoEvolvePath, readTextFile } from "./fs"
import type { KnowledgeMaintainerSessionReportRef } from "./knowledge-maintainer/contract"
import { methodPaths, readMethodPrompt } from "./methods"
import type { JudgeHardCheckArtifact } from "./judge/contract"

function bulletList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n")
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function formatMaterialPaths(caseSpec: CaseSpec, caseDir: string) {
  return caseSpec.materials.map((item) => {
    const resolved = path.join(caseDir, item.path)
    const label = item.label?.trim() ? `${item.label}: ` : ""
    return `${label}${resolved}`
  })
}

function buildExecutionGuidance(system?: string) {
  if (!system?.trim()) return ""
  return `Additional execution guidance:\n${system.trim()}\n\n`
}

function describeWorkspaceDocument(input: ExperienceWorkspaceLayout["documents"][number]) {
  const flags: string[] = []
  if (input.isEntry) flags.push("entry")
  if (input.role && input.role !== "entry") flags.push(`role=${input.role}`)
  return flags.length ? `- ${input.absolutePath} (${flags.join(", ")})` : `- ${input.absolutePath}`
}

function experienceWorkspaceBlock(workspace: ExperienceWorkspaceLayout) {
  return [
    `Experience workspace root: ${workspace.root}`,
    `Single entry file: ${workspace.entryPath}`,
    `Current Markdown files (${workspace.documents.length}):`,
    ...(workspace.documents.length ? workspace.documents.map(describeWorkspaceDocument) : ["- (empty)"]),
  ].join("\n")
}

function templateLibraryBlock(templateLibrary: TemplateLibraryPaths) {
  return [
    `Template library root: ${templateLibrary.root}`,
    "These templates are references for the knowledge maintainer agent.",
    "They are not automatically part of the final experience workspace.",
    ...(templateLibrary.files.length
      ? templateLibrary.files.map((file) => `- ${file}`)
      : ["- (no templates found)"]),
  ].join("\n")
}

function baselineBlock(baselinePath: string) {
  return [
    `User baseline file: ${baselinePath}`,
    "- Treat this file as user-authored starting guidance.",
    "- It may be incomplete, speculative, or highly creative.",
    "- Use it as optional context, not as authoritative truth.",
  ].join("\n")
}

function judgeBlock(input: { judgeSummaryPath?: string; judgeReportPath?: string }) {
  if (!input.judgeSummaryPath && !input.judgeReportPath) {
    return "No judge outputs were provided for this maintenance round."
  }
  return [
    input.judgeSummaryPath ? `Judge summary path: ${input.judgeSummaryPath}` : "",
    input.judgeReportPath ? `Judge report path: ${input.judgeReportPath}` : "",
    "- Read these judge outputs before deciding how to maintain the experience workspace.",
  ]
    .filter(Boolean)
    .join("\n")
}

function judgeSkillsBlock(input: { judgeSkillsRoot: string; judgeSkillsIndexPath: string }) {
  return [
    `Judge skills root: ${input.judgeSkillsRoot}`,
    `Judge skills index: ${input.judgeSkillsIndexPath}`,
    "- Read INDEX.md first to see available local judge skills.",
    "- These skills are project-local only; they are not global tools.",
  ].join("\n")
}

function hardCheckResultsBlock(runDir: string, artifacts: JudgeHardCheckArtifact[]) {
  if (!artifacts.length) {
    return "No hard-check outputs were precomputed for this judge run."
  }

  return [
    `Run root: ${normalizeSlash(runDir)}`,
    "Prepared hard-check result files:",
    ...artifacts.map((item) => `- ${item.skillID}: ${item.relativeOutputPath} (status=${item.status})`),
  ].join("\n")
}

function judgeModeBlock(mode: string) {
  if (mode === "soft_plus_hard") {
    return [
      "- mode: soft_plus_hard",
      "- system has already precomputed configured hard checks",
      "- you should review those prepared outputs first",
      "- you may still inspect local judge skills if deeper analysis is useful",
    ].join("\n")
  }

  return [
    "- mode: soft_only",
    "- no hard checks were precomputed automatically",
    "- you may decide whether local judge skills are worth using",
  ].join("\n")
}

async function readSystemPrompt(cwd: string, config: AutoEvolveConfig, name: string) {
  return readTextFile(autoEvolvePath(cwd, config.systemPromptsDir, name))
}

function sessionReportsBlock(runDir: string, reports: KnowledgeMaintainerSessionReportRef[]) {
  const normalizedRunDir = normalizeSlash(runDir)
  if (!reports.length) {
    return [
      `Run root: ${normalizedRunDir}`,
      "No session execution reports were selected for this maintenance round.",
    ].join("\n")
  }

  return [
    `Run root: ${normalizedRunDir}`,
    "Selected session execution reports (use these relative paths to inspect prior behavior):",
    ...reports.map((report) => {
      const meta = [
        `phase=${report.phase}`,
        report.caseID ? `case=${report.caseID}` : "",
        report.attempt !== undefined ? `attempt=${report.attempt}` : "",
        report.sessionID ? `session=${report.sessionID}` : "",
      ].filter(Boolean)
      return `- ${report.label}: ${report.relativePath}${meta.length ? ` (${meta.join(", ")})` : ""}`
    }),
  ].join("\n")
}

function bootstrapCaseBlock(item: LoadedCase) {
  const materials = formatMaterialPaths(item.spec, item.caseDir)
  const expectedPath = path.join(item.caseDir, item.spec.expected.path)
  return [
    `Case ${item.spec.id}`,
    `- case spec: ${item.casePath}`,
    `- instruction: ${item.spec.instruction.trim()}`,
    `- compare mode: ${item.spec.expected.mode}`,
    `- materials:`,
    materials.length ? materials.map((entry) => `  - ${entry}`).join("\n") : "  - none",
    `- expected result: ${expectedPath}`,
  ].join("\n")
}

function renderTemplate(template: string, variables: Record<string, string>) {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, rawKey: string) => variables[rawKey] ?? "")
}

export async function buildBootstrapPrompt(input: {
  cwd: string
  config: AutoEvolveConfig
  methodID?: string
  workspace: ExperienceWorkspaceLayout
  templateLibrary: TemplateLibraryPaths
  baselinePath: string
  scriptsDir: string
  cases: LoadedCase[]
}) {
  const paths = methodPaths(input.cwd, input.config, input.methodID)
  const template = await readMethodPrompt(paths, "bootstrap")
  const caseBlocks = input.cases.length
    ? input.cases.map((item) => bootstrapCaseBlock(item)).join("\n\n")
    : "No labeled cases were attached."

  return renderTemplate(template, {
    experience_workspace_block: experienceWorkspaceBlock(input.workspace),
    template_library_block: templateLibraryBlock(input.templateLibrary),
    baseline_block: baselineBlock(input.baselinePath),
    scripts_dir: input.scriptsDir,
    case_blocks: caseBlocks,
  })
}

export async function buildSolvePrompt(input: {
  cwd: string
  config: AutoEvolveConfig
  methodID?: string
  caseSpec: CaseSpec
  caseDir: string
  workspace: ExperienceWorkspaceLayout
  baselinePath: string
  scriptsDir: string
}) {
  const paths = methodPaths(input.cwd, input.config, input.methodID)
  const template = await readMethodPrompt(paths, "solve")
  const materialPaths = formatMaterialPaths(input.caseSpec, input.caseDir)

  return renderTemplate(template, {
    experience_workspace_block: experienceWorkspaceBlock(input.workspace),
    baseline_block: baselineBlock(input.baselinePath),
    scripts_dir: input.scriptsDir,
    execution_guidance: buildExecutionGuidance(input.caseSpec.execution?.system),
    case_id: input.caseSpec.id,
    compare_mode: input.caseSpec.expected.mode,
    instruction: input.caseSpec.instruction.trim(),
    material_list: bulletList(materialPaths),
  })
}

export async function buildKnowledgeMaintainerPrompt(input: {
  cwd: string
  config: AutoEvolveConfig
  methodID?: string
  runDir: string
  caseSpec: CaseSpec
  caseDir: string
  workspace: ExperienceWorkspaceLayout
  templateLibrary: TemplateLibraryPaths
  baselinePath: string
  scriptsDir: string
  expectedPath: string
  actualPath: string
  evaluationPath: string
  actionTracePath: string
  judgeBlock: string
  attempt: number
  methodContractBlock: string
  methodExtensionBlock: string
  reversePropagationModuleBlock: string
  loadingStrategyBlock: string
  maintenanceScopeBlock: string
  maintenanceOpsBlock: string
  sessionReports: KnowledgeMaintainerSessionReportRef[]
}) {
  const template = await readSystemPrompt(input.cwd, input.config, "knowledge-maintainer-core.md")
  const materialPaths = formatMaterialPaths(input.caseSpec, input.caseDir)

  return renderTemplate(template, {
    experience_workspace_block: experienceWorkspaceBlock(input.workspace),
    template_library_block: templateLibraryBlock(input.templateLibrary),
    baseline_block: baselineBlock(input.baselinePath),
    scripts_dir: input.scriptsDir,
    attempt: String(input.attempt),
    case_id: input.caseSpec.id,
    instruction: input.caseSpec.instruction.trim(),
    material_list: bulletList(materialPaths),
    expected_path: input.expectedPath,
    actual_path: input.actualPath,
    evaluation_path: input.evaluationPath,
    action_trace_path: input.actionTracePath,
    judge_block: input.judgeBlock,
    session_reports_block: sessionReportsBlock(input.runDir, input.sessionReports),
    method_contract_block: input.methodContractBlock,
    reverse_propagation_module_block: input.reversePropagationModuleBlock,
    loading_strategy_block: input.loadingStrategyBlock,
    maintenance_scope_block: input.maintenanceScopeBlock,
    maintenance_ops_block: input.maintenanceOpsBlock,
    method_extension_block: input.methodExtensionBlock,
  })
}

export const buildRefinePrompt = buildKnowledgeMaintainerPrompt

export async function buildSoftJudgePrompt(input: {
  cwd: string
  config: AutoEvolveConfig
  methodID?: string
  runDir: string
  caseSpec: CaseSpec
  workspace: ExperienceWorkspaceLayout
  baselinePath: string
  expectedPath: string
  actualPath: string
  evaluationPath: string
  actionTracePath: string
  routingPath: string
  attempt: number
  judgeMode: string
  judgeSkillsRoot: string
  judgeSkillsIndexPath: string
  hardCheckArtifacts: JudgeHardCheckArtifact[]
  judgeSummaryPath: string
  judgeReportPath: string
  judgeExtensionBlock: string
  sessionReports: KnowledgeMaintainerSessionReportRef[]
}) {
  const template = await readSystemPrompt(input.cwd, input.config, "soft-judge-core.md")

  return renderTemplate(template, {
    judge_mode_block: judgeModeBlock(input.judgeMode),
    experience_workspace_block: experienceWorkspaceBlock(input.workspace),
    baseline_block: baselineBlock(input.baselinePath),
    attempt: String(input.attempt),
    case_id: input.caseSpec.id,
    instruction: input.caseSpec.instruction.trim(),
    expected_path: input.expectedPath,
    actual_path: input.actualPath,
    evaluation_path: input.evaluationPath,
    action_trace_path: input.actionTracePath,
    routing_path: input.routingPath,
    session_reports_block: sessionReportsBlock(input.runDir, input.sessionReports),
    judge_skills_block: judgeSkillsBlock({
      judgeSkillsRoot: input.judgeSkillsRoot,
      judgeSkillsIndexPath: input.judgeSkillsIndexPath,
    }),
    hard_check_results_block: hardCheckResultsBlock(input.runDir, input.hardCheckArtifacts),
    judge_summary_path: input.judgeSummaryPath,
    judge_report_path: input.judgeReportPath,
    judge_extension_block: input.judgeExtensionBlock,
  })
}
