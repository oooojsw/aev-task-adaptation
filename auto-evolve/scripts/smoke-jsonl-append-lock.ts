import path from "node:path"
import { spawn } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { autoEvolvePath, ensureDirectory } from "../orchestrator/fs"
import { appendJsonlIfMissingLocked, appendJsonlLinesLocked, appendJsonlLocked } from "../orchestrator/jsonl"

async function readLines(target: string) {
  const raw = await readFile(target, "utf8").catch(() => "")
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

if (process.argv[2] === "child") {
  const target = process.argv[3]
  const worker = process.argv[4]
  const count = Number(process.argv[5])
  if (!target || !worker || !Number.isFinite(count) || count <= 0) {
    throw new Error("child mode requires target, worker and count")
  }
  for (let index = 0; index < count; index += 1) {
    await appendJsonlLocked(target, {
      id: `${worker}-${index}`,
      worker,
      index,
      createdAt: new Date().toISOString(),
    })
  }
  process.exit(0)
}

async function runChild(scriptPath: string, target: string, worker: string, count: number) {
  const child = spawn(process.execPath, [scriptPath, "child", target, worker, String(count)], {
    stdio: "inherit",
    windowsHide: true,
  })
  const code = await new Promise<number>((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode ?? 1))
    child.on("error", () => resolve(1))
  })
  if (code !== 0) throw new Error(`child ${worker} failed with exit code ${code}`)
}

async function main() {
  const cwd = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dir, "..", "..")
  const root = path.join(autoEvolvePath(cwd), "runtime-state", "tmp-smoke-jsonl-append-lock")
  const target = path.join(root, "index.jsonl")
  const dedupeTarget = path.join(root, "dedupe.jsonl")
  const aggregateTarget = path.join(root, "aggregate.jsonl")

  await rm(root, { recursive: true, force: true })
  await ensureDirectory(root)

  const workers = 8
  const perWorker = 200
  await Promise.all(
    Array.from({ length: workers }, (_, index) =>
      runChild(import.meta.path, target, `worker-${index}`, perWorker),
    ),
  )

  const lines = await readLines(target)
  const expectedRows = workers * perWorker
  if (lines.length !== expectedRows) throw new Error(`Expected ${expectedRows} jsonl rows, got ${lines.length}`)

  const parsed = lines.map((line) => JSON.parse(line) as { id: string })
  const ids = new Set(parsed.map((item) => item.id))
  if (ids.size !== expectedRows) throw new Error(`Expected ${expectedRows} unique ids, got ${ids.size}`)

  await Promise.all(
    Array.from({ length: 50 }, () =>
      appendJsonlIfMissingLocked(
        dedupeTarget,
        { id: "same-record", value: 1 },
        (existing: { id: string }, next: { id: string }) => existing.id === next.id,
      ),
    ),
  )

  const dedupeLines = await readLines(dedupeTarget)
  if (dedupeLines.length !== 1) throw new Error(`Expected dedupe jsonl to contain 1 row, got ${dedupeLines.length}`)

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      appendJsonlLinesLocked(aggregateTarget, [
        JSON.stringify({ id: `aggregate-${index}-a` }),
        "",
        JSON.stringify({ id: `aggregate-${index}-b` }),
      ]),
    ),
  )
  const aggregateLines = await readLines(aggregateTarget)
  if (aggregateLines.length !== 40) throw new Error(`Expected aggregate jsonl to contain 40 rows, got ${aggregateLines.length}`)

  console.log(
    JSON.stringify(
      { passed: true, rows: lines.length, dedupeRows: dedupeLines.length, aggregateRows: aggregateLines.length },
      null,
      2,
    ),
  )
}

await main()
