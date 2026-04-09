import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Session } from "../../session"
import { SessionStatus } from "../../session/status"
import { MessageV2 } from "../../session/message-v2"
import { SessionID } from "../../session/schema"
import { bootstrap } from "../bootstrap"
import { UI } from "../ui"
import { Locale } from "../../util/locale"
import { Flag } from "../../flag/flag"
import { Filesystem } from "../../util/filesystem"
import { Process } from "../../util/process"
import { EOL } from "os"
import path from "path"
import { which } from "../../util/which"
import open from "open"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { errorMessage } from "../../util/error"

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .command(SessionMonitorCommand)
      .command(SessionDashboardCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = cmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs: Argv) => {
    return yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessionID = SessionID.make(args.sessionID)
      try {
        await Session.get(sessionID)
      } catch {
        UI.error(`Session not found: ${args.sessionID}`)
        process.exit(1)
      }
      await Session.remove(sessionID)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
    })
  },
})

export const SessionListCommand = cmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs: Argv) => {
    return yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const sessions = [...Session.list({ roots: true, limit: args.maxCount })]

      if (sessions.length === 0) {
        return
      }

      let output: string
      if (args.format === "json") {
        output = formatSessionJSON(sessions)
      } else {
        output = formatSessionTable(sessions)
      }

      const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

      if (shouldPaginate) {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      } else {
        console.log(output)
      }
    })
  },
})

type MonitorStatus = "running" | "retry" | "done" | "error" | "archived" | "idle"

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
}

function truncateMiddle(input: string, max: number) {
  if (input.length <= max) return input
  const keep = Math.max(3, Math.floor((max - 3) / 2))
  return `${input.slice(0, keep)}...${input.slice(input.length - keep)}`
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

function previewText(input: string | undefined, max = 80) {
  if (!input) return undefined
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized
}

function unfinishedReasoning(parts: MessageV2.Part[]) {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part.type !== "reasoning") continue
    if (!part.time?.end) return part
  }
}

function summarizeSession(
  session: Session.GlobalInfo,
  status: SessionStatus.Info,
  messages: MessageV2.WithParts[],
): MonitorRow {
  const assistant = latestAssistant(messages)
  const user = latestUser(messages)
  const parts = assistant?.parts ?? []
  const activeTool = findActiveTool(parts)

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
          : undefined) ?? activeTool.state.status
    } else if (unfinishedText(parts)) {
      monitorStatus = "running"
      step = "text"
      detail = previewText(unfinishedText(parts)?.text)
    } else if (unfinishedReasoning(parts)) {
      monitorStatus = "running"
      step = "reasoning"
      detail = previewText(unfinishedReasoning(parts)?.text)
    } else if (hasOpenStep(parts)) {
      monitorStatus = "running"
      step = "step"
    } else if (user) {
      monitorStatus = "running"
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
    detail = previewText(lastText?.text)
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
  }
}

async function collectMonitorRows(limit?: number) {
  const statuses = await SessionStatus.list()
  const sessions = [...Session.listGlobal({ limit, archived: true })]
  const rows: MonitorRow[] = []

  for (const session of sessions) {
    const messages = await Session.messages({ sessionID: session.id, limit: 8 }).catch(() => [] as MessageV2.WithParts[])
    rows.push(summarizeSession(session, statuses.get(session.id) ?? { type: "idle" }, messages))
  }

  return rows
}

function renderMonitor(rows: MonitorRow[]) {
  const running = rows.filter((row) => row.status === "running" || row.status === "retry").length
  const done = rows.filter((row) => row.status === "done").length
  const errored = rows.filter((row) => row.status === "error").length
  const archived = rows.filter((row) => row.status === "archived").length
  const idle = rows.filter((row) => row.status === "idle").length

  const idWidth = Math.max(20, ...rows.map((row) => row.id.length))
  const statusWidth = 10
  const stepWidth = 20
  const titleWidth = Math.max(20, ...rows.map((row) => Math.min(40, row.title.length)))

  const lines: string[] = []
  lines.push(`Sessions: ${rows.length}  Running: ${running}  Done: ${done}  Error: ${errored}  Archived: ${archived}  Idle: ${idle}`)
  lines.push("")
  lines.push(
    `Session ID${" ".repeat(Math.max(0, idWidth - 10))}  Status${" ".repeat(Math.max(0, statusWidth - 6))}  Step${" ".repeat(Math.max(0, stepWidth - 4))}  Updated             Title`,
  )
  lines.push("鈹€".repeat(idWidth + statusWidth + stepWidth + titleWidth + 34))

  for (const row of rows) {
    const line =
      `${row.id.padEnd(idWidth)}  ` +
      `${row.status.padEnd(statusWidth)}  ` +
      `${truncateMiddle(row.step, stepWidth).padEnd(stepWidth)}  ` +
      `${Locale.todayTimeOrDateTime(row.updated).padEnd(18)}  ` +
      `${Locale.truncate(row.title, titleWidth)}`
    lines.push(line)
    if (row.detail) {
      lines.push(`${" ".repeat(idWidth + statusWidth + stepWidth + 6)}  -> ${Locale.truncate(row.detail, 80)}`)
    }
    if (row.parentID) {
      lines.push(`${" ".repeat(idWidth + statusWidth + stepWidth + 6)}  parent: ${row.parentID}`)
    }
  }

  return lines.join(EOL)
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
  <title>OpenCode Session Monitor</title>
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
    .wrap {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 20px;
    }
    .title {
      margin: 0 0 8px;
      font-size: 28px;
      font-weight: 700;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
    }
    .controls {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .controls input, .controls button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 14px;
    }
    .controls button {
      cursor: pointer;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .card {
      background: rgba(21, 28, 34, 0.94);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px 16px;
    }
    .card .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .card .value {
      font-size: 24px;
      font-weight: 700;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(21, 28, 34, 0.94);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1100px;
    }
    th, td {
      text-align: left;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 14px;
    }
    th {
      position: sticky;
      top: 0;
      background: #151c22;
      z-index: 1;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      border: 1px solid var(--line);
      white-space: nowrap;
    }
    .status-running { color: var(--running); }
    .status-retry { color: var(--retry); }
    .status-done { color: var(--done); }
    .status-error { color: var(--error); }
    .status-archived { color: var(--archived); }
    .status-idle { color: var(--idle); }
    .muted { color: var(--muted); }
    .detail {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .mono {
      font-family: Consolas, "SFMono-Regular", monospace;
      font-size: 12px;
    }
    .empty {
      padding: 28px;
      text-align: center;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <h1 class="title">OpenCode Session Monitor</h1>
        <p class="subtitle">持续观察当前有哪些 session 在运行、哪些已经结束、现在卡在什么步骤。</p>
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
            <th>最近更新</th>
            <th>目录</th>
            <th>标题 / 细节</th>
          </tr>
        </thead>
        <tbody id="rows">
          <tr><td colspan="6" class="empty">正在加载…</td></tr>
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

    function statusClass(status) {
      return "status-" + status;
    }

    function timeText(timestamp) {
      return new Date(timestamp).toLocaleString("zh-CN", {
        hour12: false
      });
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
      ].map(([label, value]) => \`<div class="card"><div class="label">\${label}</div><div class="value">\${value}</div></div>\`).join("");
    }

    function renderRows(rows) {
      if (!rows.length) {
        rowsEl.innerHTML = '<tr><td colspan="6" class="empty">当前没有 session。</td></tr>';
        return;
      }
      rowsEl.innerHTML = rows.map((row) => {
        const detail = row.detail ? \`<div class="detail">\${row.detail.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</div>\` : "";
        const parent = row.parentID ? \`<div class="detail">parent: <span class="mono">\${row.parentID}</span></div>\` : "";
        return \`
          <tr>
            <td class="mono">\${row.id}</td>
            <td><span class="pill \${statusClass(row.status)}">\${row.status}</span></td>
            <td class="mono">\${row.step}</td>
            <td>\${timeText(row.updated)}</td>
            <td class="mono">\${row.directory}</td>
            <td>
              <div>\${row.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</div>
              \${detail}
              \${parent}
            </td>
          </tr>
        \`;
      }).join("");
    }

    async function load() {
      const limit = Math.max(1, Number(limitEl.value || ${limit}));
      const response = await fetch("/api/sessions?limit=" + limit, { cache: "no-store" });
      if (!response.ok) {
        const text = await response.text();
        rowsEl.innerHTML = '<tr><td colspan="6" class="empty">加载失败：' + text.replaceAll("<", "&lt;") + '</td></tr>';
        return;
      }
      const payload = await response.json();
      renderSummary(payload.rows);
      renderRows(payload.rows);
      lastUpdatedEl.textContent = "最近刷新: " + new Date(payload.generatedAt).toLocaleString("zh-CN", { hour12: false });
    }

    function restartTimer() {
      if (timer) clearInterval(timer);
      const seconds = Math.max(1, Number(intervalEl.value || ${intervalSeconds}));
      timer = setInterval(() => {
        load().catch((err) => {
          lastUpdatedEl.textContent = "刷新失败: " + err.message;
        });
      }, seconds * 1000);
    }

    refreshBtn.addEventListener("click", () => load().catch((err) => {
      lastUpdatedEl.textContent = "刷新失败: " + err.message;
    }));
    intervalEl.addEventListener("change", restartTimer);
    limitEl.addEventListener("change", () => {
      load().catch((err) => {
        lastUpdatedEl.textContent = "刷新失败: " + err.message;
      });
    });

    load().catch((err) => {
      lastUpdatedEl.textContent = "刷新失败: " + err.message;
    });
    restartTimer();
  </script>
</body>
</html>`
}

function clearTerminal() {
  process.stdout.write("\x1Bc")
}

export const SessionMonitorCommand = cmd({
  command: "monitor",
  describe: "monitor session runtime state",
  builder: (yargs: Argv) =>
    yargs
      .option("watch", {
        alias: "w",
        describe: "refresh continuously",
        type: "boolean",
        default: false,
      })
      .option("interval", {
        alias: "i",
        describe: "refresh interval in seconds",
        type: "number",
        default: 2,
      })
      .option("limit", {
        alias: "n",
        describe: "maximum number of sessions to show",
        type: "number",
        default: 20,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const render = async () => {
        const rows = await collectMonitorRows(args.limit)
        if (args.format === "json") {
          console.log(JSON.stringify(rows, null, 2))
          return
        }
        console.log(renderMonitor(rows))
      }

      if (!args.watch) {
        await render()
        return
      }

      const intervalMs = Math.max(1, Number(args.interval) || 2) * 1000
      while (true) {
        clearTerminal()
        await render()
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    })
  },
})

export const SessionDashboardCommand = cmd({
  command: "dashboard",
  describe: "start an external browser dashboard for session monitoring",
  builder: (yargs: Argv) =>
    withNetworkOptions(yargs)
      .option("open", {
        describe: "open the dashboard in a browser",
        type: "boolean",
        default: true,
      })
      .option("limit", {
        alias: "n",
        describe: "maximum number of sessions shown in the dashboard",
        type: "number",
        default: 30,
      })
      .option("interval", {
        alias: "i",
        describe: "default refresh interval in seconds",
        type: "number",
        default: 2,
      }),
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    const limit = Math.max(1, Number(args.limit) || 30)
    const interval = Math.max(1, Number(args.interval) || 2)

    const server = Bun.serve({
      hostname: opts.hostname,
      port: opts.port,
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url)

        if (url.pathname === "/api/sessions") {
          try {
            const requestLimit = Math.max(1, Number(url.searchParams.get("limit") || limit))
            const rows = await bootstrap(process.cwd(), async () => collectMonitorRows(requestLimit))
            return Response.json({
              generatedAt: Date.now(),
              rows,
            })
          } catch (error) {
            return new Response(
              JSON.stringify({
                error: errorMessage(error),
              }),
              {
                status: 500,
                headers: { "content-type": "application/json; charset=utf-8" },
              },
            )
          }
        }

        if (url.pathname === "/api/health") {
          return Response.json({ healthy: true, generatedAt: Date.now() })
        }

        return new Response(renderDashboardHtml({ limit, intervalSeconds: interval }), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        })
      },
    })

    const hostname = opts.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname
    const dashboardUrl = `http://${hostname}:${server.port}`
    console.log(`Session dashboard listening on ${dashboardUrl}`)

    if (args.open) {
      open(dashboardUrl).catch(() => {})
    }

    await new Promise(() => {})
    await server.stop()
  },
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}
