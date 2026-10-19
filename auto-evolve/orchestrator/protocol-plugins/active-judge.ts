import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { CheckerPlugin, Settings } from "./contract"
import { fingerprint } from "./identity"
import type { Evaluate } from "./runtime"
import { toolSession, type InvokeTool } from "./tool-session"

export async function activeJudge(options: { evidenceRoot: string; backendImplementation: string; invoke: InvokeTool;
  requestGate?: string;
  requestBudgets?: Parameters<typeof toolSession>[0]["requestBudgets"] }) {
  const tool = await toolSession({ ...options, purpose: "checking" })
  const own = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")
  function settings(value: Settings) {
    tool.descriptor.validate(value)
    if (value.outputKind !== "json") throw new Error("Active judge requires JSON verdict output")
  }
  const descriptor: CheckerPlugin = { id: "active-tool-judge", version: "1",
    implementation: fingerprint({ own, tool: tool.descriptor.implementation }), targets: ["skill", "product"],
    mechanisms: ["judge"], productKinds: ["text", "json"], validate: settings }
  const evaluate: Evaluate = async input => {
    settings(input.settings)
    // 私有判据只给正式检查者；不经训练侧转交或变成作者材料。
    const evidence = [...input.materials.map(item => ({ ...item, id: `source:${item.id}` })),
      ...input.privateInputs.map(item => ({ ...item, id: `criterion:${item.id}` }))]
    if (!evidence.length || [...evidence, ...input.candidate].some(item => !["text", "json"].includes(item.kind))) {
      return { status: "data_error", message: "Active checker requires declared text or JSON evidence" }
    }
    const instruction = [input.settings.instruction,
      `You are the formal checker for ${input.check.target} check ${input.check.name}, not the author or reviewer.`,
      'Read relevant evidence files yourself. Write JSON: {"status":"passed" or "rejected","message":"actionable reasons","evidence":[{"id":"source:<id> or criterion:<id>","quote":"exact supporting text"}]}.',
      "Every verdict must include at least one exact nonempty evidence quote. Do not disclose confidential grading text in the message.",
      "If evidence is insufficient, reject with the specific missing support. Do not alter the candidate, sources, or criteria.",
    ].join("\n")
    const result = await tool.execute({ task: input.task, phase: input.phase, skill: input.candidate,
      materials: evidence, settings: { ...input.settings, instruction } })
    if (result.status !== "completed" || !result.product) return { status: "scoring_error", message: "Active checker execution failed" }
    let verdict
    try { verdict = JSON.parse(Buffer.from(result.product.bytes).toString("utf8").replace(/^\uFEFF/, "")) }
    catch { return { status: "scoring_error", message: "Active checker returned malformed JSON" } }
    if (!verdict || !["passed", "rejected"].includes(verdict.status) || typeof verdict.message !== "string" ||
      !verdict.message.trim() || !Array.isArray(verdict.evidence) || !verdict.evidence.length || verdict.evidence.length > 100 ||
      verdict.evidence.some((reference: { id?: unknown; quote?: unknown }) => {
        if (!reference || typeof reference.id !== "string" || typeof reference.quote !== "string" || !reference.quote.trim()) return true
        const item = evidence.find(item => item.id === reference.id)
        return !item || !["text", "json"].includes(item.kind) || !Buffer.from(item.bytes).toString("utf8").includes(reference.quote)
      })) return { status: "scoring_error", message: "Active checker verdict lacks traceable source evidence" }
    // 引用原文留在私有检查证据；训练侧仅按原反馈授权接收判词。
    return { status: verdict.status, message: verdict.message, ...(result.usage ? { usage: result.usage } : {}) }
  }
  return { descriptor, evaluate }
}
