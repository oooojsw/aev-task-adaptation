import path from "node:path"
import { readFile, readdir, realpath, mkdir, open, lstat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { fingerprint } from "./identity"
import { autoEvolvePath } from "../fs"
import { writeJsonAtomic } from "../atomic-write"
import type { AutoEvolveConfig } from "../schema"
import type { OpencodeTaskInput, OpencodeTaskRun } from "../opencode"
import type { InvokeTool } from "./tool-session"
import { backendUsage } from "./backend-usage"
import { validateToolRequest } from "./tool-request-boundary"
import { preflightSourceHost } from "./host-preflight"

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
    const hostFiles: Array<{ path: string; sha256: string }> = []
    async function visitHost(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) throw new Error("Source host links unsupported")
        if (entry.isDirectory()) await visitHost(file)
        else if (entry.isFile()) hostFiles.push({ path: path.relative(cwd, file).replace(/\\/g, "/"),
          sha256: createHash("sha256").update(await readFile(file)).digest("hex") })
      }
    }
    // 真实后端冻结宿主源码；测试注入不能冒充真实宿主。
    if (!options.invoke) {
      for (const dir of ["packages/opencode/src", "packages/plugin/src", "packages/sdk/js/src", "packages/util/src"]) {
        await visitHost(path.join(cwd, dir))
      }
      for (const file of ["package.json", "bun.lock", "packages/opencode/package.json", "packages/opencode/tsconfig.json", "packages/opencode/bunfig.toml"]) {
        hostFiles.push({ path: file, sha256: createHash("sha256").update(await readFile(path.join(cwd, file))).digest("hex") })
      }
    }
    const normalized = JSON.parse(JSON.stringify(config)) as AutoEvolveConfig
    const source = await readFile(fileURLToPath(new URL("../opencode.ts", import.meta.url)))
    const own = await readFile(fileURLToPath(import.meta.url))
    const usageSource = await readFile(fileURLToPath(new URL("./backend-usage.ts", import.meta.url)))
    const boundarySource = await readFile(fileURLToPath(new URL("./tool-request-boundary.ts", import.meta.url)))
    const retryPolicy = await readFile(fileURLToPath(new URL("../opencode-retry-policy.ts", import.meta.url)))
    const budgetTransport = await readFile(fileURLToPath(new URL("../task-adaptation/budget-transport.ts", import.meta.url)))
    const budgetLedger = await readFile(fileURLToPath(new URL("../task-adaptation/request-budget.ts", import.meta.url)))
    const readiness = await readFile(fileURLToPath(new URL("./host-preflight.ts", import.meta.url)))
    const localSearch = await readFile(fileURLToPath(new URL("../task-adaptation/local-search.ts", import.meta.url)))
    const recompute = await readFile(fileURLToPath(new URL("../task-adaptation/recompute.ts", import.meta.url)))
    // 进程桥接也会改变实际执行，须纳入恢复身份，不能只冻模型源码。
    const processHelpers = await Promise.all(["../managed-process.ts", "../opencode-runtime-budget.ts", "../windows-no-console-process.ts", "../windows-no-console-wrapper.py"].map(async file => ({
      file, sha256: createHash("sha256").update(await readFile(fileURLToPath(new URL(file, import.meta.url)))).digest("hex"),
    })))
    const key = fingerprint({ cwd, profile, files: files.sort((a, b) => a.path.localeCompare(b.path)),
      sourceHost: { kind: options.invoke ? "injected-test-boundary" : "bun-source", executable: process.execPath,
        version: typeof Bun === "undefined" ? null : Bun.version, files: hostFiles.sort((a, b) => a.path.localeCompare(b.path)) },
      config: normalized, source: createHash("sha256").update(source).digest("hex"),
      own: createHash("sha256").update(own).digest("hex"),
      usageSource: createHash("sha256").update(usageSource).digest("hex"),
      boundarySource: createHash("sha256").update(boundarySource).digest("hex"),
      retryPolicy: createHash("sha256").update(retryPolicy).digest("hex"),
      budgetTransport: createHash("sha256").update(budgetTransport).digest("hex"),
      budgetLedger: createHash("sha256").update(budgetLedger).digest("hex"),
      readiness: createHash("sha256").update(readiness).digest("hex"),
      localSearch: createHash("sha256").update(localSearch).digest("hex"),
      recompute: createHash("sha256").update(recompute).digest("hex"), processHelpers })
    return { key, config: normalized }
  }
  const frozen = await identity()
  let ready: Promise<void> | undefined
  async function preflight() {
    const currentProfile = path.resolve(process.env.AUTO_EVOLVE_OPENCODE_PRIVATE_PROFILE_ROOT?.trim() || autoEvolvePath(cwd, ".opencode-private"))
    if (currentProfile !== profile || (await identity()).key !== frozen.key) throw new Error("OpenCode host/config/profile fingerprint changed")
    // 每个驱动实例只预检一次；测试替身不冒充实际源码宿主。
    if (!options.invoke) await (ready ??= preflightSourceHost({ cwd, evidenceRoot: options.evidenceRoot }))
  }
  const run: InvokeTool = async (request, signal) => {
    request = structuredClone(request)
    await preflight()
    if (signal.aborted) throw new Error("Tool execution already aborted")
    await validateToolRequest(request)
    const externalPaths = new Set<string>()
    for (const file of [...request.readPaths, ...request.editPaths]) {
      const info = await lstat(file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        return null
      })
      externalPaths.add(info?.isDirectory() ? file : path.dirname(file))
    }
    const dir = path.join(options.evidenceRoot, fingerprint({ host: frozen.key, request }))
    await mkdir(dir, { recursive: true })
    const claim = await open(path.join(dir, "started.claim"), "wx")
    await claim.close()
    const startedAt = new Date().toISOString()
    const clock = performance.now()
    const record = async (fields: Record<string, unknown>) => writeJsonAtomic(path.join(dir, "invocation.accounting.json"), {
      schema: "aev.backend-invocation-accounting.v1", host: frozen.key, requestFingerprint: fingerprint(request),
      requestedModel: request.model, startedAt, finishedAt: new Date().toISOString(),
      role: request.requestBudget?.role ?? "tool-backend", gate: request.requestBudget?.gate ?? null,
      elapsedMs: Math.max(0, Math.round(performance.now() - clock)), reused: false,
      fee: null, ...fields,
    })
    try {
    // 每次传副本，避免宿主修改冻结配置影响后续请求。
    const result = await invoke({ cwd, workDir: request.workDir, config: structuredClone(frozen.config),
      title: "Protocol independent tool execution", prompt: request.prompt, model: request.model, sourceHost: true,
      ...(request.requestBudget ? { requestBudget: request.requestBudget } : {}),
      referencePaths: request.readPaths, permissionReadPaths: request.readPaths,
      permissionEditPaths: request.editPaths, allowShell: false, isolateHostRuntime: true,
      permissionExternalPaths: [...externalPaths],
      infrastructureAttempts: 1, injectPlatformSafetyRules: false, recordAdaptiveConcurrency: false,
      runtimeBudget: { profile: "short", softDeadlineMs: request.timeoutMs, hardTimeoutMs: request.timeoutMs,
        silentTimeoutMs: request.timeoutMs, silentTimeoutAfterActivityMs: request.timeoutMs },
      onSpawn: () => { if (signal.aborted) throw new Error("Tool execution aborted before spawn acknowledgement") } })
    await writeJsonAtomic(path.join(dir, "task-result.json"), result)
    const resolved = result.result.modelResolution
    // 这里只认宿主记录的实际模型解析，不把请求别名当回显证据。
    const actualModel = resolved ? `${resolved.providerID}/${resolved.modelID}` : ""
    const reported = backendUsage(result.result.events)
    const completed = result.result.exitCode === 0 && !signal.aborted
    await record({ status: completed ? "completed" : "incomplete", actualModel,
      exitCode: result.result.exitCode, usageSource: reported.steps.length ? "step_finish" : "missing",
      inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, steps: reported.steps,
      rawResultSha256: createHash("sha256").update(await readFile(path.join(dir, "task-result.json"))).digest("hex"),
      errorKind: completed ? null : "backend_incomplete" })
    return { completed: result.result.exitCode === 0 && !signal.aborted,
      actualModel, usage: reported.usage, evidence: [path.join(dir, "task-result.json"), path.join(dir, "invocation.accounting.json")] }
    } catch (error) {
      // 不保存异常原文，避免上游错误携带凭证；开始标记仍阻断重发。
      await writeJsonAtomic(path.join(dir, "failure.json"), {
        status: "infrastructure_error", host: frozen.key, aborted: signal.aborted,
        errorKind: error instanceof Error ? "backend_error" : "non_error_throw",
      })
      await record({ status: "infrastructure_error", actualModel: null, inputTokens: null, outputTokens: null,
        usageSource: "missing", steps: [], errorKind: signal.aborted ? "aborted" : "backend_error" })
      throw new Error("OpenCode protocol invocation failed; inspect driver failure evidence", { cause: error })
    }
  }
  return { implementation: frozen.key, invoke: run, preflight }
}
