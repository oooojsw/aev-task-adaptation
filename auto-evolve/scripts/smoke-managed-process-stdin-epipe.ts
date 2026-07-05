import { runManagedProcess } from "../orchestrator/managed-process"

const result = await runManagedProcess({
  title: "smoke-managed-process-stdin-epipe",
  command:
    process.platform === "win32"
      ? ["cmd.exe", "/c", "exit", "7"]
      : ["sh", "-c", "exit 7"],
  cwd: process.cwd(),
  stdinText: "x".repeat(1024 * 1024),
  timeoutMs: 30_000,
})

if (result.exitCode !== 7 && result.exitCode !== 1) {
  throw new Error(`Expected controlled child failure exit code, got ${result.exitCode}`)
}

console.log(
  JSON.stringify({
    ok: true,
    exitCode: result.exitCode,
    stderrHasManagedProcessNote: result.stderr.includes("[managed-process]"),
  }),
)
