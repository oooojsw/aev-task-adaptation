import path from "node:path"
import process from "node:process"
import { cleanupRuntimeProcessScope, registerRuntimeProcess, terminateProcessTree } from "../orchestrator/runtime-process-registry"

function fail(msg: string): never {
  throw new Error(msg)
}

async function assertStaticWiring() {
  const runner = await Bun.file(path.resolve(import.meta.dir, "..", "orchestrator", "long-task-campaign", "runner.ts")).text()
  if (!runner.includes("async function retryWriteJson(")) fail("missing retryWriteJson helper in runner.ts")
  if (!runner.includes("const wroteCampaign = await retryWriteJson(campaignStatePath")) {
    fail("runner.ts missing campaign retryWriteJson wiring")
  }
  if (!runner.includes("const wroteRun = await retryWriteJson(progressPath")) {
    fail("runner.ts missing run retryWriteJson wiring")
  }

  const merger = await Bun.file(path.resolve(import.meta.dir, "..", "orchestrator", "multi-instance", "merger.ts")).text()
  if (!merger.includes("Manifest JSON path: ${manifestPath}")) fail("merger.ts missing manifest path wiring")
  if (!merger.includes("buildInstanceIndex(")) fail("merger.ts missing instance index builder")
  if (!merger.includes("Read the manifest first, then read each harvested skill from disk via those paths.")) {
    fail("merger.ts missing file-first merge prompt instruction")
  }
}

async function launchSleepers(count: number) {
  const children = Array.from({ length: count }, () =>
    Bun.spawn(["powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 120"], {
      stdout: "ignore",
      stderr: "ignore",
    }),
  )
  await new Promise((r) => setTimeout(r, 120))
  return children.filter((child) => typeof child.pid === "number" && child.pid > 0)
}

async function assertRuntimeRegistryConcurrency() {
  const scope = `smoke:registry:${Date.now()}`
  const children = await launchSleepers(4)
  if (!children.length) fail("failed to spawn sleepers for runtime registry smoke test")
  const pids = children.map((child) => child.pid as number)

  const writes = pids.flatMap((pid) =>
    Array.from({ length: 5 }, (_, i) => registerRuntimeProcess(scope, pid, `sleep-${i}`)),
  )
  await Promise.all(writes)

  const result = await cleanupRuntimeProcessScope(scope)
  const missing = pids.filter((pid) => !result.killedCount && result.remainingCount > 0 && pid > 0)
  if (missing.length > 0) {
    fail(`cleanupRuntimeProcessScope left tracked children behind: ${missing.join(",")}`)
  }

  for (const child of children) {
    await terminateProcessTree(child.pid).catch(() => false)
  }
}

async function main() {
  await assertStaticWiring()
  await assertRuntimeRegistryConcurrency()
  console.log("smoke-concurrency-regression: PASS")
}

main().catch((error) => {
  console.error("smoke-concurrency-regression: FAIL")
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
