import path from "node:path"
import { readFile, readdir, realpath, mkdir, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { fingerprint } from "./identity"
import { autoEvolvePath } from "../fs"
import { writeJsonAtomic } from "../atomic-write"
import type { AutoEvolveConfig } from "../schema"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"
import type { InvokeTool } from "./tool-session"

export async function opencodeDriver(options: { cwd: string; evidenceRoot: string;
  load?: (cwd: string) => Promise<AutoEvolveConfig>;
  invoke?: (input: OpencodeTaskInput) => Promise<OpencodeTaskRun> }) {
  if (!path.isAbsolute(options.cwd) || !path.isAbsolute(options.evidenceRoot)) throw new Error("Absolute OpenCode host/evidence root required")
  const cwd = await realpath(options.cwd)
  const profile = path.resolve(process.env.AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT?.trim() || autoEvolvePath(cwd, ".opencode-private"))
  const load = options.load ?? (async (dir) => (await import("../schema")).loadConfig(dir))
  const invoke = options.invoke ?? (async (input) => (await import("../opencode")).runOpencodeTask(input))
  async function identity() {
    const files: Array<{ path: string; sha256: string }> = []
    async function visit(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Private profile links unsupported")
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) await visit(file)
        else if (entry.isFile()) files.push({ path: path.relative(profile, file).replace(/\\/g, "/"),
          sha256: createHash("sha256").update(await readFile(file)).digest("hex") })
        else throw new Error("Unsupported private profile artifact")
      }
    }
    await visit(profile)
    if (!files.length) throw new Error("Explicit private OpenCode profile required")
    const config = await load(cwd)
    const normalized = JSON.parse(JSON.stringify(config)) as AutoEvolveConfig
    const source = await readFile(fileURLToPath(new URL("../opencode.ts", import.meta.url)))
    const own = await readFile(fileURLToPath(import.meta.url))
    const retryPolicy = await readFile(fileURLToPath(new URL("../opencode-retry-policy.ts", import.meta.url)))
    const key = fingerprint({ cwd, profile, files: files.sort((a, b) => a.path.localeCompare(b.path)),
      config: normalized, source: createHash("sha256").update(source).digest("hex"),
      own: createHash("sha256").update(own).digest("hex"),
      retryPolicy: createHash("sha256").update(retryPolicy).digest("hex") })
    return { key, config: normalized }
  }
  const frozen = await identity()
  async function preflight() {
    const currentProfile = path.resolve(process.env.AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT?.trim() || autoEvolvePath(cwd, ".opencode-private"))
    if (currentProfile !== profile || (await identity()).key !== frozen.key) throw new Error("OpenCode host/config/profile fingerprint changed")
  }
  const run: InvokeTool = async (request, signal) => {
    await preflight()
    if (signal.aborted) throw new Error("Tool execution already aborted")
    const dir = path.join(options.evidenceRoot, fingerprint({ host: frozen.key, request }))
    await mkdir(dir, { recursive: true })
    const claim = await open(path.join(dir, "started.claim"), "wx")
    await claim.close()
    try {
    // 每次传副本，避免宿主修改冻结配置影响后续请求。
    const result = await invoke({ cwd, workDir: request.workDir, config: structuredClone(frozen.config),
      title: "Protocol independent tool execution", prompt: request.prompt, model: request.model,
      referencePaths: request.readPaths, permissionReadPaths: request.readPaths,
      permissionEditPaths: request.editPaths, allowShell: false, isolateHostRuntime: true,
      infrastructureAttempts: 1, injectPlatformSafetyRules: false, recordAdaptiveConcurrency: false,
      runtimeBudget: { profile: "short", softDeadlineMs: request.timeoutMs, hardTimeoutMs: request.timeoutMs,
        silentTimeoutMs: request.timeoutMs, silentTimeoutAfterActivityMs: request.timeoutMs },
      onSpawn: () => { if (signal.aborted) throw new Error("Tool execution aborted before spawn acknowledgement") } })
    await writeJsonAtomic(path.join(dir, "task-result.json"), result)
    const resolved = result.result.modelResolution
    // 这里只认宿主记录的实际模型解析，不把请求别名当回显证据。
    const actualModel = resolved ? `${resolved.providerID}/${resolved.modelID}` : ""
    return { completed: result.result.exitCode === 0 && !signal.aborted,
      actualModel, evidence: [path.join(dir, "task-result.json")] }
    } catch (error) {
      // 不保存异常原文，避免上游错误携带凭证；开始标记仍阻断重发。
      await writeJsonAtomic(path.join(dir, "failure.json"), {
        status: "infrastructure_error", host: frozen.key, aborted: signal.aborted,
        errorKind: error instanceof Error ? "backend_error" : "non_error_throw",
      })
      throw new Error("OpenCode protocol invocation failed; inspect driver failure evidence", { cause: error })
    }
  }
  return { implementation: frozen.key, invoke: run, preflight }
}
