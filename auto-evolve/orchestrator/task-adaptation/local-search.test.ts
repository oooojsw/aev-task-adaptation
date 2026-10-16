import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, writeFile, readFile, mkdir, readdir, link } from "node:fs/promises"
import { bindLocalSearch, searchLocalFiles, localSearchEnvironment, searchFromEnvironment, validateLocalSearchAccess } from "./local-search"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-local-search-"))
  const source = path.join(root, "source.txt")
  const draft = path.join(root, "draft.md")
  const secret = path.join(root, "secret.txt")
  await writeFile(source, "first\r\nSource supports 42\r\nlast")
  await writeFile(draft, "Draft 41")
  await writeFile(secret, "SECRET_UNAUTHORIZED")
  const scope = await bindLocalSearch("a".repeat(64), "worker", [
    { id: "source", path: source, mutable: false }, { id: "draft", path: draft, mutable: true },
  ])
  const config = { ...scope, evidenceRoot: path.join(root, "evidence") }
  return { root, source, draft, secret, scope, config }
}

test("local search reads only granted resource IDs and records actual evidence", async () => {
  const f = await fixture()
  const result = await searchLocalFiles(f.config, { query: "42", resources: ["source"] })
  expect(result.matches).toEqual([{ resource: "source", line: 2, text: "Source supports 42", lineTruncated: false }])
  expect(result.inspectedCount).toBe(1)
  expect(JSON.stringify(result)).not.toContain(f.secret)
  const files = await readdir(f.config.evidenceRoot)
  expect(files).toHaveLength(1)
  const receipt = JSON.parse(await readFile(path.join(f.config.evidenceRoot, files[0]), "utf8"))
  expect(receipt.fingerprint).toBe(result.receipt)
  expect(receipt.inspected[0]).toMatchObject({ id: "source", sha256: f.scope.resources[0].sha256 })
  await expect(searchLocalFiles(f.config, { query: "SECRET", resources: ["secret"] })).rejects.toThrow("Invalid scoped search")
  await expect(searchLocalFiles(f.config, { query: "SECRET", resources: [f.secret] })).rejects.toThrow("Invalid scoped search")
  expect((await searchLocalFiles(f.config, { query: "SECRET" })).matches).toEqual([])
})

test("immutable source drift fails while mutable candidates use their actual current bytes", async () => {
  const f = await fixture()
  await writeFile(f.draft, "Draft 42")
  expect((await searchLocalFiles(f.config, { query: "42", resources: ["draft"] })).matches[0].text).toBe("Draft 42")
  await writeFile(f.source, "altered source")
  await expect(searchLocalFiles(f.config, { query: "42" })).rejects.toThrow("Frozen search resource drift")
})

test("literal search never treats regex patterns as executable patterns and discloses result limits", async () => {
  const f = await fixture()
  await writeFile(f.draft, Array(150).fill(".*literal").join("\n"))
  const result = await searchLocalFiles(f.config, { query: ".*", resources: ["draft"] })
  expect(result.matches).toHaveLength(100)
  expect(result.truncated).toBe(true)
  expect((await searchLocalFiles(f.config, { query: "^Draft.*$", resources: ["draft"] })).matches).toEqual([])
  await writeFile(f.draft, "match" + "x".repeat(10000))
  expect((await searchLocalFiles(f.config, { query: "match", resources: ["draft"] })).matches[0].lineTruncated).toBe(true)
})

test("binary, oversized, hardlinked and cancelled inputs cannot produce successful evidence", async () => {
  const f = await fixture()
  await writeFile(f.draft, Buffer.from([0, 1, 2]))
  await expect(searchLocalFiles(f.config, { query: "x", resources: ["draft"] })).rejects.toThrow("UTF-8 text")
  await writeFile(f.draft, Buffer.alloc(8 * 1024 * 1024 + 1))
  await expect(searchLocalFiles(f.config, { query: "x", resources: ["draft"] })).rejects.toThrow("limit")
  await writeFile(f.draft, "ordinary text")
  await link(f.draft, path.join(f.root, "alias.txt"))
  await expect(searchLocalFiles(f.config, { query: "x", resources: ["draft"] })).rejects.toThrow("Linked task resource")
  const controller = new AbortController()
  controller.abort()
  await expect(searchLocalFiles(f.config, { query: "42", resources: ["source"] }, controller.signal)).rejects.toThrow()
})

test("environment binding is explicit, hashed and cleared when unselected", async () => {
  const f = await fixture()
  const dir = path.join(f.root, "config")
  await mkdir(dir)
  const env = await localSearchEnvironment(f.config, dir)
  expect((await searchFromEnvironment({ query: "42" }, env)).matches).toHaveLength(1)
  await writeFile(env.OPENCODE_AEV_LOCAL_SEARCH_FILE!, "{}")
  await expect(searchFromEnvironment({ query: "42" }, env)).rejects.toThrow("binding drift")
  await expect(searchFromEnvironment({ query: "42" }, {})).rejects.toThrow("Explicit frozen")
  expect(await localSearchEnvironment(undefined, dir)).toEqual({
    OPENCODE_AEV_LOCAL_SEARCH_FILE: undefined, OPENCODE_AEV_LOCAL_SEARCH_SHA256: undefined,
  })
})

test("tool binding cannot widen the actual backend's read or edit grants", async () => {
  const f = await fixture()
  expect(() => validateLocalSearchAccess(f.scope, [f.source, f.draft], [f.draft], f.config.evidenceRoot)).not.toThrow()
  expect(() => validateLocalSearchAccess(f.scope, [f.source], [f.draft], f.config.evidenceRoot)).toThrow("actual file permissions")
  expect(() => validateLocalSearchAccess(f.scope, [f.source, f.draft], [], f.config.evidenceRoot)).not.toThrow()
  expect(() => validateLocalSearchAccess(f.scope, [f.root, f.source, f.draft], [f.draft], f.config.evidenceRoot)).toThrow("outside model grants")
})
