import { runSkillsBenchVerifier } from "../orchestrator/skillsbench-adapter"

function valueAfter(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  return typeof value === "string" && value.trim() ? value : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const taskRoot = valueAfter(args, "--task-root")
  const workDir = valueAfter(args, "--work-dir")
  const logsDir = valueAfter(args, "--logs-dir")
  const imageTag = valueAfter(args, "--image-tag")
  const timeoutRaw = valueAfter(args, "--timeout-ms")
  const skipDockerBuild = args.includes("--skip-docker-build")

  if (!taskRoot || !workDir || !logsDir) {
    console.log(
      JSON.stringify(
        {
          passed: false,
          blocking: true,
          summary: "Missing required SkillsBench verifier args: --task-root, --work-dir, --logs-dir.",
          details: args,
        },
        null,
        2,
      ),
    )
    process.exit(2)
  }

  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined
  const result = await runSkillsBenchVerifier({
    taskRoot,
    workDir,
    logsDir,
    imageTag,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    skipDockerBuild,
  })

  console.log(
    JSON.stringify(
      {
        passed: result.passed,
        blocking: !result.passed,
        summary: result.summary,
        failureKind: result.failureKind ?? null,
        details: result.details,
        evidenceRefs: [result.logsDir],
      },
      null,
      2,
    ),
  )
  process.exit(result.passed ? 0 : 1)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.log(
    JSON.stringify(
      {
        passed: false,
        blocking: true,
        summary: `SkillsBench verifier crashed: ${message}`,
        details: [message],
      },
      null,
      2,
    ),
  )
  process.exit(1)
})
