import { runHiddenChildProcess } from "../orchestrator/hidden-child-process"

const result = await runHiddenChildProcess({
  command: process.execPath,
  args: ["--version"],
  cwd: process.cwd(),
  env: { ...process.env },
})

if (result.exitCode !== 0 || !result.stdout.trim()) {
  throw new Error(`Hidden child smoke failed: exit=${result.exitCode} stderr=${result.stderr}`)
}

let noVisibleConsoleVerified: boolean | undefined
if (process.platform === "win32") {
  const visibilityScript = [
    "Add-Type -Namespace Native -Name ConsoleWindow -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);'",
    "$handle = [Native.ConsoleWindow]::GetConsoleWindow()",
    "[PSCustomObject]@{ Handle = $handle.ToInt64(); Visible = [Native.ConsoleWindow]::IsWindowVisible($handle) } | ConvertTo-Json -Compress",
  ].join("; ")
  const visibility = await runHiddenChildProcess({
    command: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", visibilityScript],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 10_000,
  })
  const state = JSON.parse(visibility.stdout) as { Handle?: number; Visible?: boolean }
  noVisibleConsoleVerified = visibility.exitCode === 0 && state.Handle === 0 && state.Visible === false
  if (!noVisibleConsoleVerified) {
    throw new Error(`Expected no visible console window; exit=${visibility.exitCode} output=${visibility.stdout}`)
  }
}

console.log(JSON.stringify({ ok: true, exitCode: result.exitCode, output: result.stdout.trim(), noVisibleConsoleVerified }))
