import path from "node:path"
import type { Plan } from "./plan"
import { resolveResource } from "./binding"
import type { PhaseProtocol } from "../protocol-plugins/contract"
import type { PackSnapshot } from "../protocol-plugins/project-pack"

function same(actual: string[], expected: string[]) {
  return actual.length === expected.length && [...actual].sort().every((id, index) => id === [...expected].sort()[index])
}

export async function verifyProtocolScopes(plan: Readonly<Plan>, root: string, project: PackSnapshot,
  taskID: string, protocol: PhaseProtocol) {
  const task = project.pack.tasks.find(item => item.id === taskID)
  if (!task) throw new Error("Task scope missing project task")
  const entries = project.pack.skill.entries.map(item => item.id)
  const materials = task.materials.map(item => item.id)
  const split = async (ids: string[]) => {
    const selected = { skill: [] as string[], materials: [] as string[], private: [] as string[] }
    for (const id of ids) {
      const resource = plan.resources.find(item => item.id === id)
      if (!resource) throw new Error("Task scope missing resource")
      if (plan.deliverable.entries.includes(id)) {
        if (!entries.includes(id)) throw new Error("Task scope missing candidate entry")
        selected.skill.push(id)
        continue
      }
      const publicFile = task.materials.find(item => item.id === id)
      const privateFile = task.privateInputs.find(item => item.id === id)
      if (publicFile && privateFile) throw new Error("Task scope ambiguous input identity")
      const file = publicFile ?? privateFile
      if (!file || (publicFile && resource.audience !== "public") || resource.mutable) throw new Error("Task scope input role mismatch")
      // 同名不代表同材料，必须核对实际文件归属。
      const actual = await resolveResource(project.root, file.path)
      const expected = await resolveResource(root, resource.path)
      if (path.relative(actual, expected) !== "") throw new Error("Task scope physical input mismatch")
      selected[publicFile ? "materials" : "private"].push(id)
    }
    return selected
  }
  for (const check of plan.acceptance.checks) {
    const actual = protocol.checks.find(item => item.name === check.id)
    if (!actual) throw new Error("Task scope missing protocol check")
    const expected = await split(check.resources)
    if (!same(actual.skillInputs ?? entries, expected.skill) ||
        !same(actual.materialInputs ?? materials, expected.materials) ||
        !same(actual.privateInputs ?? [], expected.private) ||
        (actual.feedback ?? "status_only") !== (check.feedback === "message" ? "checker_message" : "status_only")) {
      throw new Error(`Task checker input scope mismatch: ${check.id}`)
    }
  }
  if (plan.acceptance.execution !== "none") {
    const window = plan.windows.find(item => item.role === "independent" && item.stage === "accept")
    if (!window) throw new Error("Task execution requires independent input window")
    const expected = await split(window.reads)
    if (expected.private.length || !same(protocol.executionInputs?.skill ?? entries, expected.skill) ||
        !same(protocol.executionInputs?.materials ?? materials, expected.materials)) throw new Error("Task execution input scope mismatch")
    // 合并后端有固定表面检查与产物判分，不冒充任意脚本执行器。
    const consolidation = protocol.executor?.id === "consolidation-direct-chat" && plan.deliverable.kind === "skill" &&
      entries.length === 1 && protocol.checks.length === 2 &&
      ["skill", "product"].every(target => protocol.checks.some(check => check.id === "consolidation-checker" &&
        check.target === target && check.required && check.mechanism === "script"))
    if (protocol.executor?.id === "consolidation-direct-chat" && !consolidation) throw new Error("Task consolidation backend mismatch")
    const script = protocol.executor?.id === "script-json-executor" || consolidation
    if (script !== (plan.acceptance.execution === "script")) throw new Error("Task execution backend mismatch")
  }
}
