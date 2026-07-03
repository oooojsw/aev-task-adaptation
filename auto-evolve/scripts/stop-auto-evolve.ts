import path from "node:path"
import { stopAutoEvolveRun, type StopMode } from "../orchestrator/stop-manager"

function parseArgs(argv: string[]) {
  const result: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      result[key] = true
    } else {
      result[key] = next
      i += 1
    }
  }
  return result
}

function isStopMode(value: unknown): value is StopMode {
  return value === "pause" || value === "drain" || value === "kill-only" || value === "abort" || value === "snapshot-only"
}

function usage() {
  return [
    "Usage:",
    "  bun run auto-evolve/scripts/stop-auto-evolve.ts --out <benchmark-or-direct-chat-out-dir> [--mode pause]",
    "  bun run auto-evolve/scripts/stop-auto-evolve.ts --campaign <campaign-id-or-dir> [--mode pause]",
    "",
    "Modes:",
    "  pause         default; save state as resumable and stop owned processes",
    "  snapshot-only only write snapshots/reports",
    "  kill-only     stop owned processes without changing business state",
    "  abort         reserved for explicit discard; not recommended",
    "",
    "Safety:",
    "  The stop manager does not delete artifacts. It writes stop-snapshots, artifact-manifest.stop.json, and stop-reports.",
  ].join("\n")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    console.log(usage())
    return
  }
  const mode = isStopMode(args.mode) ? args.mode : "pause"
  const outDir = typeof args.out === "string" ? path.resolve(args.out) : undefined
  const campaignID = typeof args.campaign === "string" ? args.campaign : undefined
  if (!outDir && !campaignID) {
    throw new Error(`${usage()}\n\nMissing --out or --campaign.`)
  }
  const result = await stopAutoEvolveRun({
    cwd: path.resolve(process.cwd()),
    outDir,
    campaignID,
    mode,
    reason: typeof args.reason === "string" ? args.reason : undefined,
    dryRun: Boolean(args["dry-run"]),
    force: Boolean(args.force),
  })
  console.log(JSON.stringify({
    mode: result.mode,
    dryRun: result.dryRun,
    target: result.target,
    summary: result.summary,
    resumable: result.resumable,
    reportPath: result.reportPath,
    markdownPath: result.markdownPath,
    snapshotDir: result.snapshotDir,
    transactionDir: result.transactionDir,
    resume: result.resume,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
