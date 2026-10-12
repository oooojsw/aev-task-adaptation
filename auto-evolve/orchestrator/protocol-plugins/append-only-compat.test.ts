import { test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

async function check(a: string, b: string, file = "CORE.md") {
  const root = await mkdtemp(path.join(tmpdir(), "aev-append-"))
  const base = path.join(root, "base"), draft = path.join(root, "draft")
  await mkdir(base); await mkdir(draft)
  await writeFile(path.join(base, file), a); await writeFile(path.join(draft, file), b)
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../scripts/validate-append-only-skill-patch.ts"), base, draft], { stdout: "pipe", stderr: "pipe" })
  const text = await new Response(child.stdout).text()
  return { code: await child.exited, result: JSON.parse(text) }
}
test("CRLF and LF append are equivalent in either direction", async () => {
  expect((await check("old\r\nrule\r\n", "old\nrule\nnew\n")).code).toBe(0)
  expect((await check("old\nrule\n", "old\r\nrule\r\nnew\r\n")).code).toBe(0)
})
test("deleted, rewritten or whitespace-changed text still fails", async () => {
  for (const draft of ["old\n", "old\nwrong\n", "old \nrule\nnew\n"]) {
    expect((await check("old\r\nrule\r\n", draft)).code).toBe(1)
  }
})
test("immutable files remain byte-exact", async () => {
  expect((await check("old\r\n", "old\n", "fixed.txt")).code).toBe(1)
})
test("missing directories fail closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aev-append-missing-"))
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../scripts/validate-append-only-skill-patch.ts"), path.join(root,"missing"), root], { stdout:"ignore", stderr:"ignore" })
  expect(await child.exited).not.toBe(0)
})
