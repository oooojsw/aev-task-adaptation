import { mkdir, appendFile, writeFile } from "node:fs/promises"
import path from "node:path"

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith("--")) continue
    const eq = item.indexOf("=")
    if (eq > 2) {
      args[item.slice(2, eq)] = item.slice(eq + 1)
      continue
    }
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      args[key] = true
    } else {
      args[key] = next
      i += 1
    }
  }
  return args
}

async function parseArgsFromFile(argv) {
  const direct = parseArgs(argv)
  if (!direct.argsFile) return direct
  const raw = await import("node:fs/promises").then((fs) => fs.readFile(path.resolve(String(direct.argsFile)), "utf8"))
  return { ...direct, ...JSON.parse(raw.replace(/^\uFEFF/, "")) }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const args = await parseArgsFromFile(process.argv.slice(2))
  const outPath = path.resolve(String(args.out || "qwen-web-proof.jsonl"))
  const port = Number(args.port || 9222)
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, "", "utf8")

  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((res) => res.json())
  const target = targets.find((item) => item.type === "page" && String(item.url || "").startsWith("https://chat.qwen.ai"))
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No chat.qwen.ai page found on Chrome remote debugging port")
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
      return
    }
    if (message.method === "Network.requestWillBeSent") {
      const request = message.params?.request
      if (!String(request?.url || "").includes("/api/v2/chat/completions")) return
      let body = null
      try {
        body = JSON.parse(request.postData || "{}")
      } catch {
        body = { parseError: true, raw: request.postData || "" }
      }
      const firstMessage = Array.isArray(body.messages) ? body.messages[0] : undefined
      const proof = {
        capturedAt: new Date().toISOString(),
        url: request.url,
        requestID: message.params?.requestId,
        webModel: body.model || null,
        messageModels: firstMessage?.models || null,
        featureConfig: firstMessage?.feature_config || null,
        contentLength: typeof firstMessage?.content === "string" ? firstMessage.content.length : null,
      }
      appendFile(outPath, `${JSON.stringify(proof)}\n`, "utf8").catch(() => {})
    }
  })

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", reject, { once: true })
  })

  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await cdp("Network.enable")
  const snapshot = await cdp("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => ({
      url: location.href,
      header: document.querySelector('#qwen-chat-header-left')?.innerText || '',
      thinking: document.querySelector('.qwen-select-thinking-label-text')?.innerText || '',
      modelLines: [...new Set(document.body.innerText.split('\\n').map(x => x.trim()).filter(x => /^Qwen3/.test(x)))]
    }))()`,
  })
  await appendFile(
    outPath,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), type: "initial-page-snapshot", page: snapshot.result?.value || null })}\n`,
    "utf8",
  )

  // Keep the process alive until the launcher stops it.
  while (true) await sleep(60_000)
}

main().catch(async (error) => {
  console.error(error)
  process.exit(1)
})
