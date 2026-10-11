import path from "node:path"
import { readFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { productEvidenceName } from "./runtime"

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
  return paths
}
