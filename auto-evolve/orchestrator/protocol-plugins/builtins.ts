import path from "node:path"
import { Runtime } from "./runtime"
import { httpChat } from "./http-chat"
import { scriptChecker } from "./script-checker"
import { cachedExecution, cachedScoring } from "./cache"
import { modelJudge } from "./model-judge"

export async function builtins(root: string) {
  if (!path.isAbsolute(root)) throw new Error("Absolute plugin backend root required")
  const runtime = new Runtime()
  const http = await httpChat({ evidenceRoot: path.join(root, "http") })
  const script = await scriptChecker(path.join(root, "scripts"))
  // 执行与评分分别缓存，换评分配置不重复发送答题请求。
  runtime.addExecutor(http.descriptor, cachedExecution(path.join(root, "cache"), http.descriptor, http.execute))
  runtime.addChecker(script.descriptor, cachedScoring(path.join(root, "cache"), script.descriptor, script.evaluate, script.preflight))
  const judge = await modelJudge({ evidenceRoot: path.join(root, "judges") })
  runtime.addChecker(judge.descriptor, cachedScoring(path.join(root, "cache"), judge.descriptor, judge.evaluate))
  return runtime
}
