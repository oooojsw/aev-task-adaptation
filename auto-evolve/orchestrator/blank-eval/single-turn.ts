import path from "node:path"
import { createHash } from "node:crypto"
import { readFile, realpath, open, mkdir, stat } from "node:fs/promises"
import { writeJsonAtomic, writeFileAtomic } from "../atomic-write"
import type { LongTaskSpec } from "../long-task/contract"
import type { OpencodeTaskRun } from "../opencode"

const allowedURLs = new Set([
  "https://api.minimaxi.com/anthropic/v1/messages",
  "https://api.minimax.io/anthropic/v1/messages",
])
const digest = (text: string) => createHash("sha256").update(text).digest("hex")

async function inside(root: string, file: string) {
  const base = await realpath(root)
  const actual = await realpath(file)
  const rel = path.relative(base, actual)
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Single-turn input outside sandbox")
  return actual
}

export async function singleTurnEntries(roots: string[]) {
  const entries: string[] = []
  for (const root of roots) {
    const direct = path.join(root, "README.md")
    try {
      if (!(await stat(direct)).isFile()) throw new Error("README is not a file")
      entries.push(await inside(root, direct))
      continue
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error
    }
    const contract = JSON.parse((await readFile(path.join(root, "surface_contract.json"), "utf8")).replace(/^\uFEFF/, ""))
    const entry = typeof contract.entry === "string" ? contract.entry.replace(/\\/g, "/") : ""
    // 仅解析现存包内README路径，不把来源元数据当模型输入。
    if (!entry || path.isAbsolute(entry) || entry.includes(":") || entry.split("/").includes("..") || path.basename(entry).toLowerCase() !== "readme.md") {
      throw new Error("Invalid single-turn skill entry")
    }
    const actual = await inside(root, path.join(root, entry))
    if (!(await stat(actual)).isFile()) throw new Error("Skill entry is not a file")
    entries.push(actual)
  }
  return entries
}

export async function singleTurnRequest(input: {
  spec: LongTaskSpec; sandboxRoot: string; entries: string[]
}) {
  const cfg = input.spec.blankEvalExecutor!
  if (!Number.isSafeInteger(cfg.maxTokens) || cfg.maxTokens <= 0 ||
      !Number.isFinite(cfg.temperature) || cfg.temperature < 0 || cfg.temperature > 1) {
    throw new Error("Invalid single-turn generation budget")
  }
  if (!allowedURLs.has(cfg.url) || !/^[A-Z][A-Z0-9_]*$/.test(cfg.credentialEnv)) {
    throw new Error("Unapproved endpoint or credential environment")
  }
  const matching = input.spec.materials.filter((m) => m.label === cfg.materialLabel)
  if (matching.length !== 1) throw new Error("Exactly one frozen public material required")
  const material = await inside(input.sandboxRoot, matching[0].path)
  const source = JSON.parse((await readFile(material, "utf8")).replace(/^\uFEFF/, ""))
  if (typeof source.system_prompt !== "string" || typeof source.user_prompt !== "string") {
    throw new Error("Public material requires system_prompt and user_prompt")
  }
  // 只发送白名单正文；金标、路径和训练历史不进入请求。
  const skills: string[] = []
  for (const entry of input.entries.filter((e) => path.basename(e).toLowerCase() === "readme.md")) {
    skills.push((await readFile(await inside(input.sandboxRoot, entry), "utf8"))
      .replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim())
  }
  if (!skills.length) throw new Error("No clean README skill entry")
  const skill = skills.join("\n\n")
  const system = source.system_prompt + (skill ? `\n\n<nba_skill>\n${skill}\n</nba_skill>` : "")
  const request = { model: cfg.model, max_tokens: cfg.maxTokens, temperature: cfg.temperature,
    system, messages: [{ role: "user", content: source.user_prompt }] }
  const wire = JSON.stringify(request)
  if (Buffer.byteLength(wire.normalize("NFC"), "utf8") + cfg.maxTokens + 4096 > 204800) {
    throw new Error("Single-turn conservative context bound exceeded; no truncation")
  }
  const relative = cfg.outputRelativePath.replace(/\\/g, "/")
  if (!relative.startsWith("workspace/") || relative.split("/").includes("..") || relative.includes(":")) {
    throw new Error("Single-turn output must stay in sandbox workspace")
  }
  const output = path.join(input.sandboxRoot, relative)
  await inside(input.sandboxRoot, path.dirname(output))
  if (!input.spec.targetPaths?.some((t) => path.resolve(t.path) === path.resolve(output))) {
    throw new Error("Single-turn output is not a declared product target")
  }
  return { request, wire, output, skill, cfg }
}

export async function runSingleTurn(input: {
  spec: LongTaskSpec; sandboxRoot: string; entries: string[]; sessionDir: string; title: string
}): Promise<OpencodeTaskRun> {
  const { request, wire, output, skill, cfg } = await singleTurnRequest(input)
  const cacheRoot = process.env.AUTO_EVOLVE_SINGLE_TURN_REPLY_CACHE
  const cacheModule = cacheRoot ? await import("./single-turn-cache") : undefined
  const secret = process.env[cfg.credentialEnv]
  if (!secret) throw new Error("Missing single-turn credential environment")
  await mkdir(input.sessionDir, { recursive: true })
  // 独占占位防止同一验收会话重复收费，失败后也不删除。
  const claim = await open(path.join(input.sessionDir, "single-turn-attempt.claim"), "wx")
  await claim.close()
  await writeJsonAtomic(path.join(input.sessionDir, "single-turn-request.json"), request)
  await writeJsonAtomic(path.join(input.sessionDir, "single-turn-started.json"), {
    requestSHA256: digest(wire), skillSHA256: digest(skill), skillBytes: Buffer.byteLength(skill),
    url: cfg.url, model: cfg.model, tools: false, turns: 1, retries: 0, startedAt: new Date().toISOString(),
  })
  const cache = cacheRoot ? await cacheModule!.claimSingleTurnReply(cacheRoot, wire) : undefined
  // 只请求一次；断流或超限留证并退出，不自动重抽答卷。
  let response: Response
  let raw: string
  try {
    if (cache?.cached) {
      response = new Response(cache.cached.raw, { status: 200 })
      raw = cache.cached.raw
      await writeJsonAtomic(path.join(input.sessionDir, "single-turn-reuse.json"), {
        originalSessionDir: cache.cached.originalSessionDir, requestSHA256: digest(wire), newModelCalls: 0,
      })
    } else {
    response = await fetch(cfg.url, { method: "POST", redirect: "error", timeout: false,
    headers: { "x-api-key": secret, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: wire, signal: AbortSignal.timeout(600000) } as RequestInit & { timeout: false })
    raw = (await response.text()).split(secret).join("[REDACTED_SECRET]")
    }
  } catch (error) {
    await writeJsonAtomic(path.join(input.sessionDir, "single-turn-failure.json"), {
      requestSHA256: digest(wire), phase: "transport", retryAllowed: false,
      error: String(error).split(secret).join("[REDACTED_SECRET]"), failedAt: new Date().toISOString(),
    })
    throw new Error("Single-turn transport failure; inspect saved attempt before recovery")
  }
  await writeJsonAtomic(path.join(input.sessionDir, "single-turn-response.json"), {
    status: response.status, raw, rawSHA256: digest(raw), receivedAt: new Date().toISOString(),
  })
  const data = JSON.parse(raw)
  const blocks = Array.isArray(data.content) ? data.content : []
  const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("\n")
  if (!response.ok || data.model !== cfg.model || data.stop_reason !== "end_turn" ||
      blocks.some((b: any) => b.type === "tool_use") || !text.trim()) {
    throw new Error(`Single-turn infrastructure failure: HTTP ${response.status}, stop=${data.stop_reason ?? "unknown"}`)
  }
  await writeFileAtomic(output, text)
  await writeJsonAtomic(path.join(input.sessionDir, "single-turn-completed.json"), {
    requestSHA256: digest(wire), answerSHA256: digest(text), model: data.model, usage: data.usage,
    stopReason: data.stop_reason, completedAt: new Date().toISOString(),
    ...(cache?.cached ? { reused: true, originalSessionDir: cache.cached.originalSessionDir, newModelCalls: 0 } : {}),
  })
  if (cache && !cache.cached) await cacheModule!.saveSingleTurnReply(cache.dir, wire, raw, input.sessionDir)
  return { title: input.title, prompt: wire, selectedModel: cfg.model, referencedPaths: [],
    attachedFiles: [], promptInlineFiles: [], permissionReadPaths: [], permissionEditPaths: [output],
    result: { exitCode: 0, finishReason: data.stop_reason, stdout: raw, stderr: "",
      events: [], responseText: text, toolFailures: [] } }
}
