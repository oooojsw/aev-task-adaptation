import path from "node:path"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { runOpencodeTask } from "../orchestrator/opencode"
import { pathExists, runtimeRoot, writeJsonFile } from "../orchestrator/fs"

type TreeMetrics = {
  path: string
  exists: boolean
  bytes: number
  files: number
  directories: number
  nodeModulesDirectories: number
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
}

async function collectTreeMetrics(target: string): Promise<TreeMetrics> {
  const result: TreeMetrics = {
    path: target,
    exists: await pathExists(target),
    bytes: 0,
    files: 0,
    directories: 0,
    nodeModulesDirectories: 0,
  }
  if (!result.exists) return result

  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        result.directories += 1
        if (entry.name === "node_modules") result.nodeModulesDirectories += 1
        await walk(child)
        continue
      }
      if (entry.isFile()) {
        result.files += 1
        const info = await stat(child).catch(() => undefined)
        if (info) result.bytes += info.size
      }
    }
  }

  await walk(target)
  return result
}

function summarizeDelta(before: TreeMetrics, after: TreeMetrics) {
  return {
    bytes: after.bytes - before.bytes,
    files: after.files - before.files,
    directories: after.directories - before.directories,
    nodeModulesDirectories: after.nodeModulesDirectories - before.nodeModulesDirectories,
  }
}

async function main() {
  const cwd = process.cwd()
  const id = `opencode-runtime-cleanup-smoke-${stamp()}-${Math.random().toString(16).slice(2, 8)}`
  const smokeRoot = path.join(cwd, "auto-evolve", "runtime-state", "smoke-opencode-runtime-cleanup", id)
  const isolatedRuntimeRoot = path.join(smokeRoot, "runtime-root")
  process.env.AUTO_EVOLVE_RUNTIME_ROOT = isolatedRuntimeRoot
  process.env.AUTO_EVOLVE_OPENCODE_ISOLATE_RUNTIME = "1"
  process.env.AUTO_EVOLVE_OPENCODE_CLEAN_RUNTIME = "1"
  process.env.AUTO_EVOLVE_OPENCODE_STALE_RUNTIME_TTL_MS = "1"

  await mkdir(smokeRoot, { recursive: true })
  await mkdir(isolatedRuntimeRoot, { recursive: true })

  const config = await loadConfig(cwd)
  const root = runtimeRoot(cwd)
  const targets = {
    runtimeRoot: root,
    opencodeConfig: path.join(root, "opencode-config"),
    opencodeIsolatedEnv: path.join(root, "opencode-isolated-env"),
    opencodeGate: path.join(root, "opencode-gate"),
  }

  const before = {
    runtimeRoot: await collectTreeMetrics(targets.runtimeRoot),
    opencodeConfig: await collectTreeMetrics(targets.opencodeConfig),
    opencodeIsolatedEnv: await collectTreeMetrics(targets.opencodeIsolatedEnv),
    opencodeGate: await collectTreeMetrics(targets.opencodeGate),
  }

  const startedAt = new Date().toISOString()
  const runs = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const run = await runOpencodeTask({
        cwd,
        config,
        title: `${id}-${String(index + 1).padStart(2, "0")}`,
        prompt: `Return exactly this JSON and nothing else: {"ok":true,"index":${index + 1},"kind":"opencode-runtime-cleanup-smoke"}`,
        permissionReadPaths: [cwd],
        permissionEditPaths: [],
        runtimeScope: `smoke:opencode-runtime-cleanup:${id}`,
        concurrencyScope: `smoke:opencode-runtime-cleanup:${id}`,
      })
      return {
        index: index + 1,
        exitCode: run.result.exitCode,
        sessionID: run.result.sessionID ?? null,
        finishReason: run.result.finishReason ?? null,
        responseText: run.result.responseText.trim(),
        toolFailures: run.result.toolFailures,
        stderrTail: run.result.stderr.slice(-2000),
      }
    }),
  )
  const finishedAt = new Date().toISOString()

  const after = {
    runtimeRoot: await collectTreeMetrics(targets.runtimeRoot),
    opencodeConfig: await collectTreeMetrics(targets.opencodeConfig),
    opencodeIsolatedEnv: await collectTreeMetrics(targets.opencodeIsolatedEnv),
    opencodeGate: await collectTreeMetrics(targets.opencodeGate),
  }

  const report = {
    id,
    startedAt,
    finishedAt,
    targets,
    runs,
    before,
    after,
    delta: {
      runtimeRoot: summarizeDelta(before.runtimeRoot, after.runtimeRoot),
      opencodeConfig: summarizeDelta(before.opencodeConfig, after.opencodeConfig),
      opencodeIsolatedEnv: summarizeDelta(before.opencodeIsolatedEnv, after.opencodeIsolatedEnv),
      opencodeGate: summarizeDelta(before.opencodeGate, after.opencodeGate),
    },
    verdict: {
      allSessionsExitedZero: runs.every((run) => run.exitCode === 0),
      noToolFailures: runs.every((run) => run.toolFailures.length === 0),
      noOpencodeConfigResidue: after.opencodeConfig.directories === 0 && after.opencodeConfig.files === 0,
      noIsolatedEnvResidue: after.opencodeIsolatedEnv.directories === 0 && after.opencodeIsolatedEnv.files === 0,
      noNodeModulesResidue:
        after.opencodeConfig.nodeModulesDirectories === 0 && after.opencodeIsolatedEnv.nodeModulesDirectories === 0,
    },
  }

  await writeJsonFile(path.join(smokeRoot, "report.json"), report)
  await writeFile(
    path.join(smokeRoot, "summary.md"),
    [
      `# ${id}`,
      "",
      `- startedAt: ${startedAt}`,
      `- finishedAt: ${finishedAt}`,
      `- runtimeRoot: ${targets.runtimeRoot}`,
      `- allSessionsExitedZero: ${report.verdict.allSessionsExitedZero}`,
      `- noToolFailures: ${report.verdict.noToolFailures}`,
      `- noOpencodeConfigResidue: ${report.verdict.noOpencodeConfigResidue}`,
      `- noIsolatedEnvResidue: ${report.verdict.noIsolatedEnvResidue}`,
      `- noNodeModulesResidue: ${report.verdict.noNodeModulesResidue}`,
      `- runtimeRootBytesDelta: ${report.delta.runtimeRoot.bytes}`,
      `- opencodeConfigBytesAfter: ${after.opencodeConfig.bytes}`,
      `- opencodeIsolatedEnvBytesAfter: ${after.opencodeIsolatedEnv.bytes}`,
      `- nodeModulesAfter: ${after.runtimeRoot.nodeModulesDirectories}`,
      "",
    ].join("\n"),
  )

  console.log(JSON.stringify(report, null, 2))
}

await main()
