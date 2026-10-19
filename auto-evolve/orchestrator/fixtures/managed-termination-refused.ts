import { mock } from "bun:test"
import { fileURLToPath } from "node:url"
import * as registry from "../runtime-process-registry"
mock.module("../runtime-process-registry", () => ({ ...registry, terminateProcessTree: async () => false }))
const { runManagedProcess } = await import("../managed-process")
const result = await runManagedProcess({
  title: "termination-refused-local-fixture",
  command: [process.execPath, fileURLToPath(new URL("./managed-finite-child.ts", import.meta.url))],
  cwd: import.meta.dir,
  timeoutMs: 30000,
  deadlineAt: Date.now() + 500,
})
console.log(JSON.stringify(result))
