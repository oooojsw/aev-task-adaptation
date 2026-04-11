import type { OpencodeTaskRun } from "./opencode"
import type { AutoEvolveTaskDescriptor } from "./task-model"

function bulletList(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)"
}

export function buildSessionTaskManifest(input: {
  task: OpencodeTaskRun
  descriptor: AutoEvolveTaskDescriptor
}) {
  return [
    "# Session Task Manifest",
    "",
    "## Descriptor",
    "",
    `- title: ${input.descriptor.title}`,
    `- kind: ${input.descriptor.kind}`,
    `- layer: ${input.descriptor.layer}`,
    `- role: ${input.descriptor.role}`,
    `- phase: ${input.descriptor.phase}`,
    `- purpose: ${input.descriptor.purpose}`,
    input.descriptor.caseID ? `- case: ${input.descriptor.caseID}` : "",
    input.descriptor.attempt !== undefined ? `- attempt: ${input.descriptor.attempt}` : "",
    input.descriptor.maintenanceRound !== undefined
      ? `- maintenance round: ${input.descriptor.maintenanceRound}`
      : "",
    input.descriptor.methodID ? `- method: ${input.descriptor.methodID}` : "",
    "",
    "## Runtime Selection",
    "",
    `- model: ${input.task.selectedModel ?? "(default)"}`,
    `- agent: ${input.task.selectedAgent ?? "(default)"}`,
    `- variant: ${input.task.selectedVariant ?? "(default)"}`,
    "",
    "## Referenced Paths",
    "",
    bulletList(input.task.referencedPaths),
    "",
    "## Read Scope",
    "",
    bulletList(input.task.permissionReadPaths),
    "",
    "## Edit Scope",
    "",
    bulletList(input.task.permissionEditPaths),
    "",
  ]
    .filter(Boolean)
    .join("\n")
}
