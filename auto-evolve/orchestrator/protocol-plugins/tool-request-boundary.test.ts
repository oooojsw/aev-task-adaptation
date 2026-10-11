import { expect, test } from "bun:test"
import { mkdir, writeFile, symlink } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { validateToolRequest } from "./tool-request-boundary"
import type { ToolRequest } from "./tool-session"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "public.txt"), "Public material")
  const request: ToolRequest = { workDir: root, prompt: "Public task", model: "fixture/model",
    readPaths: [path.join(root, "public.txt")], editPaths: [path.join(root, "new", "answer.txt")],
    allowShell: false, timeoutMs: 1000, maxAttempts: 1 }
  return { root, request }
}

test("explicit existing public read and new in-workspace output are permitted", async () => {
  const f = await fixture()
  await validateToolRequest(f.request)
})

test("empty lists path patterns and external edit roots cannot reach open host permissions", async () => {
  const f = await fixture()
  await expect(validateToolRequest({ ...f.request, readPaths: [] })).rejects.toThrow("nonempty")
  await expect(validateToolRequest({ ...f.request, editPaths: [] })).rejects.toThrow("nonempty")
  await expect(validateToolRequest({ ...f.request, readPaths: [path.join(f.root, "*")] })).rejects.toThrow("non-pattern")
  await expect(validateToolRequest({ ...f.request, editPaths: [path.dirname(f.root)] })).rejects.toThrow("escaped")
  await expect(validateToolRequest({ ...f.request, readPaths: [path.join(f.root, "missing")] })).rejects.toThrow()
})

test("linked readable directories and linked output ancestors are rejected", async () => {
  const f = await fixture()
  const link = path.join(f.root, "alias")
  await symlink(f.root, link, "junction")
  await expect(validateToolRequest({ ...f.request, readPaths: [link] })).rejects.toThrow("link")
  await expect(validateToolRequest({ ...f.request, editPaths: [path.join(link, "new", "answer")] })).rejects.toThrow("link")
})
