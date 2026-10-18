import path from "node:path"
import { readFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { productEvidenceName } from "./runtime"
import type { Phase } from "./contract"
import { verifyPublication } from "../task-adaptation/consolidation/publication-evidence"

export async function protocolFeedbackEvidence(feedbackPath?: string) {
  if (!feedbackPath) return [] as string[]
  if (!path.isAbsolute(feedbackPath)) throw new Error("Absolute training feedback required")
  const root = path.dirname(feedbackPath)
  const viewPath = path.join(root, "protocol.training-feedback.json")
  const view = JSON.parse((await readFile(viewPath, "utf8")).replace(/^\uFEFF/, ""))
  if (view.schema !== "aev.training-feedback.v1") throw new Error("Invalid training feedback view")
  const paths = [viewPath]
  if (view.product) {
    const name = productEvidenceName(view.product.kind)
    const file = path.join(root, name)
    // 只授权当前答卷，禁止借反馈路径开放私有评分目录。
    if (view.product.path !== file || await realpath(file) !== path.join(await realpath(root), name)) {
      throw new Error("Training product evidence path drift")
    }
    const bytes = await readFile(file)
    if (bytes.length !== view.product.length || createHash("sha256").update(bytes).digest("hex") !== view.product.sha256) {
      throw new Error("Training product evidence hash drift")
    }
    paths.push(file)
  }
  if (view.caseFeedback) {
    const manifestFile = path.resolve(view.caseFeedback.manifestPath)
    const relative = path.relative(root, manifestFile)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Training case feedback manifest path escape")
    }
    const manifestJson = await verifyPublication(manifestFile, view.caseFeedback.manifestSHA256)
    if (manifestJson.resourceID !== view.caseFeedback.resourceID || manifestJson.totalCases !== view.caseFeedback.totalCases ||
        manifestJson.passedCases !== view.caseFeedback.passedCases) throw new Error("Training case feedback identity drift")
    paths.push(manifestFile)
  }
  return paths
}

export async function previousProtocolFeedback(campaignRoot: string, roundNumber: number, taskID: string, phase: Phase) {
  if (!path.isAbsolute(campaignRoot) || !Number.isSafeInteger(roundNumber) || roundNumber < 1 || !taskID) {
    throw new Error("Explicit previous feedback identity required")
  }
  if (roundNumber <= 1) return undefined
  const round = path.join(campaignRoot, "rounds", `round-${String(roundNumber - 1).padStart(3, "0")}`)
  const result = JSON.parse((await readFile(path.join(round, "final-acceptance", "result.json"), "utf8")).replace(/^\uFEFF/, ""))
  const file = result.protocolTrainingResultPath
  if (result.acceptanceMode !== "protocol_plugins" || result.roundNumber !== roundNumber - 1 ||
      typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Previous protocol feedback identity missing")
  const relative = path.relative(round, file)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Previous feedback path escape")
  const paths = await protocolFeedbackEvidence(file)
  const view = JSON.parse((await readFile(paths[0], "utf8")).replace(/^\uFEFF/, ""))
  if (view.task !== taskID || view.phase !== phase) throw new Error("Previous feedback task mismatch")
  // 跨轮继续使用真实公开答卷，不退回旧空白工具证据格式。
  return file as string
}
