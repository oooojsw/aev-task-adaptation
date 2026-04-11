import { createServer } from "node:http"
import process from "node:process"
import { bootstrap } from "../packages/opencode/src/cli/bootstrap"
import { Session } from "../packages/opencode/src/session"
import { SessionStatus } from "../packages/opencode/src/session/status"
import { MessageV2 } from "../packages/opencode/src/session/message-v2"
import { errorMessage } from "../packages/opencode/src/util/error"

type MonitorStatus = "running" | "retry" | "done" | "error" | "archived" | "idle"

type MonitorAction = {
  kind: "tool" | "text" | "reasoning" | "step_start" | "step_finish" | "error"
  label: string
  detail?: string
  timestamp: number
}

type MonitorRow = {
  id: string
  title: string
  parentID?: string
  directory: string
  updated: number
  archived: boolean
  status: MonitorStatus
  step: string
  detail?: string
  lastUser?: string
  recentActions: MonitorAction[]
}

function getOption(name: string, fallback: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function latestAssistant(messages: MessageV2.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].info.role === "assistant") return messages[index]
  }
}

function latestUser(messages: MessageV2.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].info.role === "user") return messages[index]
  }
}

function partTimestamp(part: MessageV2.Part) {
  if ("time" in part && part.time) {
    if ("end" in part.time && typeof part.time.end === "number") return part.time.end
    if ("start" in part.time && typeof part.time.start === "number") return part.time.start
    if ("created" in part.time && typeof part.time.created === "number") return part.time.created
  }
  return 0
}

function findActiveTool(parts: MessageV2.Part[]) {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part.type !== "tool") continue
    if (part.state.status === "pending" || part.state.status === "running") return part
  }
}

function hasOpenStep(parts: MessageV2.Part[]) {
  const lastStart = parts.map((part, index) => ({ part, index })).filter((item) => item.part.type === "step-start").at(-1)
  const lastFinish = parts
    .map((part, index) => ({ part, index }))
    .filter((item) => item.part.type === "step-finish")
    .at(-1)
  if (!lastStart) return false
  if (!lastFinish) return true
  return lastStart.index > lastFinish.index
}

function unfinishedText(parts: MessageV2.Part[]) {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part.type !== "text") continue
    if (!part.time?.end) return part
  }
}

function unfinishedReasoning(parts: MessageV2.Part[]) {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part.type !== "reasoning") continue
    if (!part.time?.end) return part
  }
}

function previewText(input: string | undefined, max = 100) {
  if (!input) return undefined
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized
}

function previewValue(input: unknown, max = 120) {
  if (input === undefined || input === null) return undefined
  if (typeof input === "string") return previewText(input, max)
  try {
    return previewText(JSON.stringify(input), max)
  } catch {
    return previewText(String(input), max)
  }
}

function actionFromPart(part: MessageV2.Part): MonitorAction | undefined {
  if (part.type === "tool") {
    const title =
      ("title" in part.state && typeof part.state.title === "string" && part.state.title)
        ? part.state.title
        : undefined
    const inputPreview = previewValue(part.state.input, 80)

    let detail: string | undefined
    if (part.state.status === "completed") {
      // For write/edit: title (file path) is more informative than "Wrote/Edited successfully."
      // For read: title is the file path, already good.
      // For grep/codesearch/glob: title is the pattern/query, already good.
      // For other tools: use title if available, otherwise input preview.
      detail = title ?? inputPreview
    } else if (part.state.status === "error") {
      // Show error message for failed tools
      detail = previewText(part.state.error, 120)
    } else {
      // pending / running: show what's being operated on
      detail = title ?? inputPreview
    }

    // Build label: include tool name and a meaningful status indicator
    let label = part.tool
    if (part.state.status === "completed") {
      label += ":done"
    } else if (part.state.status === "running") {
      label += ":running"
    } else if (part.state.status === "pending") {
      label += ":pending"
    } else if (part.state.status === "error") {
      label += ":error"
    }

    return {
      kind: "tool",
      label,
      detail,
      timestamp: partTimestamp(part),
    }
  }

  if (part.type === "text") {
    const text = previewText(part.text, 160)
    if (!text) return undefined
    return {
      kind: "text",
      label: "assistant_text",
      detail: text,
      timestamp: partTimestamp(part),
    }
  }

  if (part.type === "reasoning") {
    const text = previewText(part.text, 160)
    if (!text) return undefined
    return {
      kind: "reasoning",
      label: "reasoning",
      detail: text,
      timestamp: partTimestamp(part),
    }
  }

  if (part.type === "step-start") {
    return {
      kind: "step_start",
      label: "step_start",
      detail: part.snapshot ? `snapshot:${part.snapshot.slice(0, 10)}` : undefined,
      timestamp: partTimestamp(part),
    }
  }

  if (part.type === "step-finish") {
    return {
      kind: "step_finish",
      label: `step_finish:${part.reason}`,
      detail: part.tokens?.total ? `tokens:${part.tokens.total}` : undefined,
      timestamp: partTimestamp(part),
    }
  }
}

function collectRecentActions(messages: MessageV2.WithParts[], limit = 20) {
  const actions: MonitorAction[] = []

  for (const message of messages) {
    if (message.info.role === "assistant" && message.info.error) {
      actions.push({
        kind: "error",
        label: "assistant_error",
        detail: previewText(message.info.error.message, 160),
        timestamp: message.info.time.completed ?? message.info.time.created,
      })
    }

    for (const part of message.parts) {
      const action = actionFromPart(part)
      if (action) actions.push(action)
    }
  }

  return actions
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-limit)
}

function summarizeSession(
  session: Session.GlobalInfo,
  status: SessionStatus.Info,
  messages: MessageV2.WithParts[],
  actionsLimit = 20,
): MonitorRow {
  const assistant = latestAssistant(messages)
  const user = latestUser(messages)
  const parts = assistant?.parts ?? []
  const activeTool = findActiveTool(parts)
  const recentActions = collectRecentActions(messages, actionsLimit)

  let monitorStatus: MonitorStatus = "idle"
  let step = "idle"
  let detail: string | undefined

  if (session.time.archived) {
    monitorStatus = "archived"
    step = "archived"
  } else if (status.type === "retry") {
    monitorStatus = "retry"
    step = `retry #${status.attempt}`
    detail = status.message
  } else if (status.type === "busy") {
    monitorStatus = "running"
    if (activeTool) {
      step = `tool:${activeTool.tool}`
      detail =
        ("title" in activeTool.state && typeof activeTool.state.title === "string"
          ? activeTool.state.title
          : undefined) ?? previewValue(activeTool.state.input)
    } else if (unfinishedText(parts)) {
      step = "text"
      detail = previewText(unfinishedText(parts)?.text, 120)
    } else if (unfinishedReasoning(parts)) {
      step = "reasoning"
      detail = previewText(unfinishedReasoning(parts)?.text, 120)
    } else if (hasOpenStep(parts)) {
      step = "step"
    } else if (user) {
      step = "awaiting-assistant"
    }
  } else if (assistant?.info.role === "assistant" && assistant.info.error) {
    monitorStatus = "error"
    step = "error"
    detail = assistant.info.error.message
  } else if (assistant?.info.role === "assistant" && assistant.info.time.completed) {
    monitorStatus = "done"
    const lastFinish = [...parts].reverse().find((part) => part.type === "step-finish") as MessageV2.StepFinishPart | undefined
    step = lastFinish ? `done:${lastFinish.reason}` : "done"
    const lastText = [...parts].reverse().find((part) => part.type === "text") as MessageV2.TextPart | undefined
    detail = previewText(lastText?.text, 120)
  }

  return {
    id: session.id,
    title: session.title,
    parentID: session.parentID,
    directory: session.directory,
    updated: session.time.updated,
    archived: !!session.time.archived,
    status: monitorStatus,
    step,
    detail,
    lastUser: previewText(
      user?.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text")
        .map((part) => part.text)
        .join(" "),
      120,
    ),
    recentActions,
  }
}

async function collectMonitorRows(limit: number) {
  const statuses = await SessionStatus.list()
  const sessions = [...Session.listGlobal({ limit, archived: true })]
  const rows: MonitorRow[] = []

  for (const session of sessions) {
    const messages = await Session.messages({ sessionID: session.id, limit: 20 }).catch(() => [] as MessageV2.WithParts[])
    rows.push(summarizeSession(session, statuses.get(session.id) ?? { type: "idle" }, messages, 20))
  }

  return rows
}

function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function renderDashboardHtml(options: { limit: number; intervalSeconds: number }) {
  const limit = Math.max(1, options.limit)
  const intervalSeconds = Math.max(1, options.intervalSeconds)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auto Evolve Session Monitor</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1418;
      --panel: #151c22;
      --muted: #8b9cab;
      --text: #edf3f8;
      --line: #26323b;
      --running: #45b26b;
      --retry: #f2b84b;
      --done: #5ea3ff;
      --error: #ff6b6b;
      --archived: #8f7eff;
      --idle: #7f8b95;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: linear-gradient(180deg, #0b1014 0%, #10181f 100%);
      color: var(--text);
    }
    .wrap { max-width: 1600px; margin: 0 auto; padding: 24px; }
    .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; }
    .title { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
    .subtitle { margin: 0; color: var(--muted); font-size: 14px; }
    .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .controls input, .controls button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
    }
    .controls button { cursor: pointer; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .card { background: rgba(21, 28, 34, 0.94); border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; }
    .card .label { color: var(--muted); font-size: 12px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.08em; }
    .card .value { font-size: 24px; font-weight: 700; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 16px; background: rgba(21, 28, 34, 0.94); }
    table { width: 100%; border-collapse: collapse; min-width: 1450px; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 14px; }
    th { position: sticky; top: 0; background: #151c22; z-index: 1; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 4px 10px; font-size: 12px; border: 1px solid var(--line); white-space: nowrap; }
    .status-running { color: var(--running); }
    .status-retry { color: var(--retry); }
    .status-done { color: var(--done); }
    .status-error { color: var(--error); }
    .status-archived { color: var(--archived); }
    .status-idle { color: var(--idle); }
    .muted { color: var(--muted); }
    .detail { color: var(--muted); font-size: 12px; margin-top: 6px; white-space: pre-wrap; word-break: break-word; }
    .mono { font-family: Consolas, "SFMono-Regular", monospace; font-size: 12px; }
    .empty { padding: 28px; text-align: center; color: var(--muted); }
    .actions-cell { padding: 8px 14px !important; vertical-align: top !important; }
    .actions-cell > .detail { display: block; }
    .actions { display: flex; flex-direction: column; gap: 6px; min-width: 340px; max-height: 400px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
    .actions::-webkit-scrollbar { width: 4px; }
    .actions::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
    .action-item { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: rgba(255,255,255,0.02); flex-shrink: 0; }
    .action-label { font-size: 12px; font-family: Consolas, "SFMono-Regular", monospace; color: #b8c9d7; }
    .action-detail { margin-top: 4px; font-size: 12px; color: var(--muted); word-break: break-word; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <h1 class="title">Auto Evolve Session Monitor</h1>
        <p class="subtitle">持续观察当前有哪些 session 在运行、跑到哪一步、最近做了什么。</p>
      </div>
      <div class="controls">
        <label>刷新秒数 <input id="interval" type="number" min="1" value="${intervalSeconds}" /></label>
        <label>显示数量 <input id="limit" type="number" min="1" value="${limit}" /></label>
        <button id="refresh">立即刷新</button>
        <span id="last-updated" class="muted">尚未刷新</span>
      </div>
    </div>
    <div class="summary" id="summary"></div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>状态</th>
            <th>步骤</th>
            <th>最近动作</th>
            <th>最近更新</th>
            <th>目录</th>
            <th>标题 / 细节</th>
          </tr>
        </thead>
        <tbody id="rows">
          <tr><td colspan="7" class="empty">正在加载...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  <script>
    const summaryEl = document.getElementById("summary");
    const rowsEl = document.getElementById("rows");
    const lastUpdatedEl = document.getElementById("last-updated");
    const intervalEl = document.getElementById("interval");
    const limitEl = document.getElementById("limit");
    const refreshBtn = document.getElementById("refresh");
    let timer = null;

    function esc(input) {
      return String(input)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function statusClass(status) { return "status-" + status; }
    function timeText(timestamp) {
      return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
    }

    function renderSummary(rows) {
      const counts = {
        total: rows.length,
        running: rows.filter((row) => row.status === "running").length,
        retry: rows.filter((row) => row.status === "retry").length,
        done: rows.filter((row) => row.status === "done").length,
        error: rows.filter((row) => row.status === "error").length,
        archived: rows.filter((row) => row.status === "archived").length
      };
      summaryEl.innerHTML = [
        ["总数", counts.total],
        ["运行中", counts.running],
        ["重试中", counts.retry],
        ["已完成", counts.done],
        ["错误", counts.error],
        ["已归档", counts.archived]
      ].map(([label, value]) => '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div></div>').join("");
    }

    function renderRows(rows) {
      if (!rows.length) {
        rowsEl.innerHTML = '<tr><td colspan="7" class="empty">当前没有 session。</td></tr>';
        return;
      }
      rowsEl.innerHTML = rows.map((row) => {
        const detail = row.detail ? '<div class="detail">' + esc(row.detail) + '</div>' : "";
        const parent = row.parentID ? '<div class="detail">parent: <span class="mono">' + esc(row.parentID) + '</span></div>' : "";
        const user = row.lastUser ? '<div class="detail">user: ' + esc(row.lastUser) + '</div>' : "";
        const actions = row.recentActions?.length
          ? '<div class="actions">' + row.recentActions.map((action) =>
              '<div class="action-item"><div class="action-label">' + esc(action.label) + '</div>' +
              (action.detail ? '<div class="action-detail">' + esc(action.detail) + '</div>' : '') +
              '</div>'
            ).join('') + '</div>'
          : '<div class="detail">暂无动作</div>';
        return (
          '<tr>' +
            '<td class="mono">' + esc(row.id) + '</td>' +
            '<td><span class="pill ' + statusClass(row.status) + '">' + esc(row.status) + '</span></td>' +
            '<td class="mono">' + esc(row.step) + '</td>' +
            '<td class="actions-cell">' + actions + '</td>' +
            '<td>' + esc(timeText(row.updated)) + '</td>' +
            '<td class="mono">' + esc(row.directory) + '</td>' +
            '<td><div>' + esc(row.title) + '</div>' + detail + parent + user + '</td>' +
          '</tr>'
        );
      }).join("");
    }

    async function load() {
      const limit = Math.max(1, Number(limitEl.value || ${limit}));
      const response = await fetch("/api/sessions?limit=" + limit, { cache: "no-store" });
      if (!response.ok) {
        const text = await response.text();
        rowsEl.innerHTML = '<tr><td colspan="7" class="empty">加载失败：' + esc(text) + '</td></tr>';
        return;
      }
      const payload = await response.json();
      renderSummary(payload.rows);
      renderRows(payload.rows);
      lastUpdatedEl.textContent = "最近刷新：" + new Date(payload.generatedAt).toLocaleString("zh-CN", { hour12: false });
    }

    function restartTimer() {
      if (timer) clearInterval(timer);
      const seconds = Math.max(1, Number(intervalEl.value || ${intervalSeconds}));
      timer = setInterval(() => {
        load().catch((err) => { lastUpdatedEl.textContent = "刷新失败: " + err.message; });
      }, seconds * 1000);
    }

    refreshBtn.addEventListener("click", () => load().catch((err) => {
      lastUpdatedEl.textContent = "刷新失败: " + err.message;
    }));
    intervalEl.addEventListener("change", restartTimer);
    limitEl.addEventListener("change", () => load().catch((err) => {
      lastUpdatedEl.textContent = "刷新失败: " + err.message;
    }));

    load().catch((err) => { lastUpdatedEl.textContent = "刷新失败: " + err.message; });
    restartTimer();
  </script>
</body>
</html>`
}

async function main() {
  const hostname = getOption("--hostname", "127.0.0.1")
  const port = Math.max(1, Number(getOption("--port", "4219")) || 4219)
  const intervalSeconds = Math.max(1, Number(getOption("--interval", "2")) || 2)
  const limit = Math.max(1, Number(getOption("--limit", "50")) || 50)

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${hostname}:${port}`)

    if (url.pathname === "/api/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      response.end(JSON.stringify({ healthy: true, generatedAt: Date.now() }))
      return
    }

    if (url.pathname === "/api/sessions") {
      try {
        const requestLimit = Math.max(1, Number(url.searchParams.get("limit") || limit))
        const rows = await bootstrap(process.cwd(), async () => collectMonitorRows(requestLimit))
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        response.end(JSON.stringify({ generatedAt: Date.now(), rows }))
        return
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
        response.end(JSON.stringify({ error: errorMessage(error) }))
        return
      }
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    })
    response.end(renderDashboardHtml({ limit, intervalSeconds }))
  })

  server.listen(port, hostname, () => {
    console.log(`Auto-evolve monitor listening on ${escapeHtml(`http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${port}`)}`)
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
