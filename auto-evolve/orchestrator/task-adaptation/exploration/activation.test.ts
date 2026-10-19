import { expect, test } from "bun:test"
import { readFile, rename, lstat, readdir, mkdir, copyFile } from "node:fs/promises"
import path from "node:path"
import { writeFileAtomic } from "../../atomic-write"
import { activate, withGeneration } from "./activation"
import { fixture, interrupt } from "./composition.test"
import { compose } from "./composition"
import { overlaps } from "./materialize"
import { directoryBytes } from "../../file-transaction"

async function setup() {
  const composition = await fixture()
  return { root: path.join(path.dirname(composition.root), "activation"), composition }
}

test("activation commits one alternative pointer and rejects late old-generation work", async () => {
  const input = await setup()
  const lease = { root: input.root, scope: input.composition.scope, generation: 0 as const, cap: 1000000 }
  expect(await withGeneration(lease, async (value) => value)).toBeUndefined()
  const result = await activate(input)
  expect(result.record.generation).toBe(1)
  expect(await activate(input)).toEqual(result)
  let invoked = false
  await expect(
    withGeneration(lease, async () => {
      invoked = true
    }),
  ).rejects.toThrow("Stale")
  expect(invoked).toBe(false)
  expect(await withGeneration({ ...lease, generation: 1 }, async (value) => value?.composition)).toBe(
    result.record.composition,
  )
  expect(await readFile(path.join(result.record.view, "facts.md"), "utf8")).toBe("latest preserved fact")
})

test("active candidate edits cannot mutate frozen prepared view or invalidate committed activation", async () => {
  const input = await setup(),
    result = await activate(input)
  await withGeneration(
    { root: input.root, scope: input.composition.scope, generation: 1, cap: 1000000 },
    async (value) => {
      await writeFileAtomic(path.join(value!.view, "report.md"), "new branch work")
    },
  )
  expect(await readFile(path.join(input.composition.root, "view/report.md"), "utf8")).toBe("initial report\r\n")
  expect(await activate(input)).toEqual(result)
  expect(await readFile(path.join(result.record.view, "report.md"), "utf8")).toBe("new branch work")
})

test("a lost committed workspace cannot be silently recreated by a generation callback", async () => {
  const input = await setup(), result = await activate(input)
  await rename(result.record.view, `${result.record.view}.lost`)
  let invoked = false
  await expect(withGeneration({ root: input.root, scope: input.composition.scope, generation: 1, cap: 1000000 }, async () => { invoked = true })).rejects.toThrow()
  expect(invoked).toBe(false)
  await expect(activate(input)).rejects.toThrow()
})

test("activation recovery fills missing files without a second generation or overwrites", async () => {
  const input = await setup(),
    result = await activate(input)
  await rename(path.join(input.root, "activation.json"), path.join(input.root, "interrupted-commit.saved"))
  await rename(path.join(result.record.view, "facts.md"), path.join(input.root, "interrupted-facts.saved"))
  const file = path.join(result.record.view, "report.md"),
    before = await lstat(file)
  await expect(activate(input)).rejects.toThrow("explicit recovery")
  await expect(
    withGeneration({ root: input.root, scope: input.composition.scope, generation: 0, cap: 1000000 }, async () => true),
  ).rejects.toThrow("pending recovery")
  expect(await activate({ ...input, recover: true })).toEqual(result)
  expect((await lstat(file)).mtimeMs).toBe(before.mtimeMs)
  expect((await lstat(file)).ino).toBe(before.ino)
})

test("activation refuses an original candidate changed after composition snapshot", async () => {
  const input = await setup()
  await writeFileAtomic(path.join(input.composition.bound.root, "report.md"), "late original writer")
  await expect(activate(input)).rejects.toThrow("pre-switch candidate drift")
})

test("generation lease fences competing activation for the entire callback", async () => {
  const input = await setup()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const lease = withGeneration(
    { root: input.root, scope: input.composition.scope, generation: 0, cap: 1000000 },
    async () => {
      enter()
      await waiting
      return "done"
    },
  )
  await entered
  try {
    await expect(activate(input)).rejects.toThrow("writer active")
  } finally {
    release()
  }
  expect(await lease).toBe("done")
  expect((await activate(input)).record.generation).toBe(1)
})

test("generation rejects wrong scope and recovery cannot silently create an activation", async () => {
  const input = await setup()
  await expect(activate({ ...input, recover: true })).rejects.toThrow("intent missing")
  await activate(input)
  await expect(
    withGeneration(
      { root: input.root, scope: { ...input.composition.scope, campaign: "other" }, generation: 1, cap: 1000000 },
      async () => true,
    ),
  ).rejects.toThrow("scope")
})

test("generation zero binds identity before allowing any callback", async () => {
  const input = await setup(),
    lease = { root: input.root, scope: input.composition.scope, generation: 0 as const, cap: 1000000 }
  await withGeneration(lease, async () => true)
  let invoked = false
  const scope = { ...lease.scope, campaign: "wrong" }
  await expect(
    withGeneration({ ...lease, scope }, async () => {
      invoked = true
    }),
  ).rejects.toThrow("scope binding")
  expect(invoked).toBe(false)
})

test("copied activation records cannot redirect a second barrier to the first work directory", async () => {
  const input = await setup()
  await activate(input)
  const root = path.join(path.dirname(input.root), "other-activation")
  await withGeneration({ root, scope: input.composition.scope, generation: 0, cap: 1000000 }, async () => true)
  for (const name of ["activation.intent.json", "activation.json"])
    await copyFile(path.join(input.root, name), path.join(root, name))
  await expect(
    withGeneration({ root, scope: input.composition.scope, generation: 1, cap: 1000000 }, async () => true),
  ).rejects.toThrow("generation drift")
})

test("nested activation roots are rejected before polluting the prepared view", async () => {
  const input = await setup(),
    prepared = await compose(input.composition)
  const before = await readdir(prepared.view)
  await expect(activate({ ...input, root: prepared.view })).rejects.toThrow("Separate")
  expect(await readdir(prepared.view)).toEqual(before)
  expect(await compose(input.composition)).toEqual(prepared)
})

test("root overlap handles volume roots, UNC roots, case and similarly named siblings", () => {
  expect(overlaps("E:/", "E:/somewhere")).toBe(true)
  expect(overlaps("E:/ROOT", "e:/root/child")).toBe(true)
  expect(overlaps("//server/share/", "//server/share/child")).toBe(true)
  expect(overlaps("E:/root", "E:/root-more")).toBe(false)
  expect(overlaps("E:/root", "F:/root")).toBe(false)
})

test("invalid first activation identity leaves no binding to poison a corrected retry", async () => {
  const input = await setup()
  await expect(
    activate({
      ...input,
      composition: { ...input.composition, scope: { ...input.composition.scope, plan: "a".repeat(64) } },
    }),
  ).rejects.toThrow("binding mismatch")
  await expect(lstat(input.root)).rejects.toThrow()
  expect((await activate(input)).record.generation).toBe(1)
})

test("activation survives atomic temporary write hard kills during initial and recovery copying", async () => {
  const input = await setup()
  await compose(input.composition)
  const file = path.join(path.dirname(input.root), "interrupt-activation.json")
  await interrupt(input, file, "activation")
  expect((await readdir(path.join(input.root, "staging"))).some((name) => name.includes(".tmp-"))).toBe(true)
  await interrupt({ ...input, recover: true }, file, "activation")
  const result = await activate({ ...input, recover: true })
  expect(result.record.generation).toBe(1)
  expect((await readdir(result.record.view)).sort()).toEqual(["facts.md", "report.md", "source.txt"])
}, 30000)

test("near-cap activation reuses completed temporary bytes through repeated hard kills", async () => {
  const composition = await fixture({ report: "a".repeat(20000), facts: "b".repeat(20000),
    bounds: { candidateBytes: 50000, archiveBytes: 80000 } })
  const input = { root: path.join(path.dirname(composition.root), "activation"), composition }
  await compose(composition)
  const file = path.join(path.dirname(input.root), "near-cap-activation.json")
  await interrupt(input, file, "activation")
  await interrupt({ ...input, recover: true }, file, "activation")
  const result = await activate({ ...input, recover: true })
  expect((await readFile(path.join(result.record.view, "report.md"))).length).toBe(20000)
  expect(await directoryBytes(input.root)).toBeLessThanOrEqual(80000)
}, 30000)
