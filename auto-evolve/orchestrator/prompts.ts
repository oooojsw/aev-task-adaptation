import path from "node:path"
import type { CaseSpec, LoadedCase } from "./schema"
import type { KnowledgePackPaths } from "./knowledge-pack"
import { methodPaths, readMethodPrompt } from "./methods"
import type { AutoEvolveConfig } from "./schema"

function bulletList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n")
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

function knowledgePackBlock(knowledgePack: KnowledgePackPaths) {
  return [
    `Knowledge pack root: ${knowledgePack.root}`,
    `- manifest: ${knowledgePack.manifestPath}`,
    `- core expert rules: ${knowledgePack.coreExpertRulesPath}`,
    `- output contract: ${knowledgePack.outputContractPath}`,
    `- execution checklist: ${knowledgePack.executionChecklistPath}`,
    `- general rules: ${knowledgePack.generalRulesPath}`,
    `- exceptions: ${knowledgePack.exceptionsPath}`,
    `- failure lessons: ${knowledgePack.failureLessonsPath}`,
  ].join("\n")
}

function baselineBlock(baselinePath: string) {
  return [
    `User baseline file: ${baselinePath}`,
    "- Treat this file as user-authored starting guidance.",
    "- It may be incomplete, speculative, or highly creative.",
    "- Use it as optional context, not as authoritative truth.",
    "- The learned knowledge-pack remains the persistent expert memory.",
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
  knowledgePack: KnowledgePackPaths
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
    knowledge_pack_block: knowledgePackBlock(input.knowledgePack),
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
  knowledgePack: KnowledgePackPaths
  baselinePath: string
  scriptsDir: string
}) {
  const paths = methodPaths(input.cwd, input.config, input.methodID)
  const template = await readMethodPrompt(paths, "solve")
  const materialPaths = formatMaterialPaths(input.caseSpec, input.caseDir)

  return renderTemplate(template, {
    knowledge_pack_block: knowledgePackBlock(input.knowledgePack),
    baseline_block: baselineBlock(input.baselinePath),
    scripts_dir: input.scriptsDir,
    execution_guidance: buildExecutionGuidance(input.caseSpec.execution?.system),
    case_id: input.caseSpec.id,
    compare_mode: input.caseSpec.expected.mode,
    instruction: input.caseSpec.instruction.trim(),
    material_list: bulletList(materialPaths),
  })
}

export async function buildRefinePrompt(input: {
  cwd: string
  config: AutoEvolveConfig
  methodID?: string
  caseSpec: CaseSpec
  caseDir: string
  knowledgePack: KnowledgePackPaths
  baselinePath: string
  scriptsDir: string
  expectedPath: string
  actualPath: string
  evaluationPath: string
  actionTracePath: string
  attempt: number
  refineRoutingBlock: string
}) {
  const paths = methodPaths(input.cwd, input.config, input.methodID)
  const template = await readMethodPrompt(paths, "refine")
  const materialPaths = formatMaterialPaths(input.caseSpec, input.caseDir)

  return renderTemplate(template, {
    knowledge_pack_block: knowledgePackBlock(input.knowledgePack),
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
    refine_routing_block: input.refineRoutingBlock,
  })
}
