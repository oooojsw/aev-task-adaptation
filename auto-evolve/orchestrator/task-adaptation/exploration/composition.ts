import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "../../atomic-write"
import { checkedPath, directoryBytes, withFileTransaction } from "../../file-transaction"
import { canonical, fingerprint, immutable } from "../../protocol-plugins/identity"
import { resolveResource, verifyBinding, type BoundPlan } from "../binding"
import { readCandidate, type ArchiveScope } from "./archive"
import { explorationIdentityAny, readExplorationPolicy, type AnyExplorationPolicy } from "./policy-reader"
import { materialize, materialization, overlaps } from "./materialize"

export interface CompositionInput {
  root: string
  archive: string
  scope: ArchiveScope
  bound: BoundPlan
  policy: Readonly<AnyExplorationPolicy>
  origin: string
  current: string
  recover?: boolean
}

const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")

async function optional(file: string) {
  try {
    return await checkedPath(file, "file")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function content(file: string, expected: { bytes: number; sha256: string }) {
  const before = await checkedPath(file, "file")
  if (before.size !== expected.bytes) throw new Error("Composition source size drift")
  const data = await readFile(file)
  const after = await checkedPath(file, "file")
  if (
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    data.length !== expected.bytes ||
    hash(data) !== expected.sha256
  )
    throw new Error("Composition source identity drift")
  return data
}

async function view(root: string, expected: string[], partial: boolean) {
  try {
    await checkedPath(root, "directory")
  } catch (error) {
    if (partial && (error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  async function walk(dir: string, prefix: string) {
    for (const name of await readdir(dir)) {
      const relative = prefix + name,
        file = path.join(dir, name)
      const stat = await lstat(file)
      if (stat.isDirectory()) {
        await checkedPath(file, "directory")
        if (!expected.some((item) => item.startsWith(`${relative}/`)))
          throw new Error("Unexpected composition directory")
        await walk(file, `${relative}/`)
      } else {
        await checkedPath(file, "file")
        if (!expected.includes(relative)) throw new Error("Unexpected composition file")
      }
    }
  }
  await walk(root, "")
}

export async function compose(input: CompositionInput) {
  const cfg = readExplorationPolicy(input.policy, input.bound.plan)!
  if (
    ![input.root, input.archive].every(path.isAbsolute) ||
    overlaps(input.root, input.archive) ||
    overlaps(input.root, input.bound.root) ||
    input.scope.plan !== input.bound.fingerprint ||
    input.scope.policy !== explorationIdentityAny(cfg, input.bound.plan)
  )
    throw new Error("Composition binding mismatch")
  await verifyBinding(input.bound)
  const locator = cfg.origin.kind === "candidate" ? cfg.origin : undefined
  if (locator && (input.origin !== locator.fingerprint || overlaps(input.root, locator.archive)))
    throw new Error("Composition historical origin binding mismatch")
  const origin = await readCandidate(locator?.archive ?? input.archive, input.origin, locator?.scope ?? input.scope, cfg.bounds.archiveBytes)
  const current = await readCandidate(input.archive, input.current, input.scope, cfg.bounds.archiveBytes)
  if (
    current.record.branch !== "original" ||
    current.record.round < 1 ||
    (cfg.origin.kind === "initial" ? origin.record.round !== 0 : input.origin !== cfg.origin.fingerprint) ||
    (!locator && origin.record.round > current.record.round)
  )
    throw new Error("Composition origin or current is not eligible")
  for (const saved of [origin, current]) {
    if (
      saved.record.files.length !== input.bound.plan.deliverable.entries.length ||
      saved.record.files.some(
        (item) =>
          !input.bound.plan.deliverable.entries.includes(item.id) ||
          item.path !== input.bound.plan.resources.find((resource) => resource.id === item.id)?.path,
      )
    )
      throw new Error("Composition candidate entries differ from frozen deliverable")
  }
  const files = input.bound.plan.deliverable.entries.map((id) => {
    const saved = cfg.replace.includes(id) ? origin : current
    const item = saved.record.files.find((item) => item.id === id)!
    return {
      id,
      path: item.path,
      bytes: item.bytes,
      sha256: item.sha256,
      source: { kind: "candidate" as const, id: saved.id, file: item.file },
    }
  })
  const dependencies = cfg.dependencies.map((id) => {
    const resource = input.bound.plan.resources.find((item) => item.id === id)!
    const item = input.bound.resources.find((item) => item.id === id)!
    return {
      id,
      path: resource.path,
      bytes: item.bytes,
      sha256: item.sha256,
      source: { kind: "dependency" as const, id: input.bound.fingerprint, file: resource.path },
    }
  })
  for (const [items, cap] of [
    [files, cfg.bounds.candidateBytes],
    [dependencies, cfg.bounds.dependencyBytes],
  ] as const) {
    const size = items.reduce((sum, item) => sum + item.bytes, 0)
    if (!Number.isSafeInteger(size) || size > cap) throw new Error("Composition content capacity exceeded")
  }
  const entries = [...files, ...dependencies]
  const paths = entries.map((item) => item.path.toLowerCase())
  if (
    paths.some((item, index) =>
      paths.some((other, at) => at !== index && (item === other || item.startsWith(`${other}/`))),
    )
  )
    throw new Error("Composition output path collision")
  const record = {
    schema: "aev.exploration-composition.v1",
    scope: input.scope,
    origin: input.origin,
    current: input.current,
    ...(locator ? { originReference: locator } : {}),
    files,
    dependencies,
  }
  const id = fingerprint(record)
  const data: Buffer[] = []
  for (const item of entries) {
    const file =
      item.source.kind === "candidate"
        ? await resolveResource(locator && item.source.id === origin.id ? locator.archive : input.archive, `${item.source.id}/${item.source.file}`)
        : await resolveResource(input.bound.root, item.source.file)
    data.push(await content(file, item))
  }
  await mkdir(input.root, { recursive: true })
  await checkedPath(input.root, "directory")
  return withFileTransaction(
    input.root,
    "composition",
    async () => {
      const event = path.join(input.root, "composition.intent.json")
      const completed = path.join(input.root, "composition.json")
      const prior = await optional(event)
      const encoded = { fingerprint: id, record }
      if (prior) {
        if (
          prior.size > cfg.bounds.archiveBytes ||
          canonical(JSON.parse((await readFile(event, "utf8")).replace(/^\uFEFF/, ""))) !== canonical(encoded)
        )
          throw new Error("Composition intent drift")
      } else if (input.recover) throw new Error("Composition recovery intent missing")
      const done = await optional(completed)
      if (
        done &&
        (!prior ||
          done.size > cfg.bounds.archiveBytes ||
          canonical(JSON.parse((await readFile(completed, "utf8")).replace(/^\uFEFF/, ""))) !== canonical(encoded))
      )
        throw new Error("Composition completion drift")
      if (prior && !done && !input.recover) throw new Error("Incomplete composition requires explicit recovery")
      const target = path.join(input.root, "view")
      try {
        await lstat(target)
        if (!prior) throw new Error("Unclaimed composition view exists")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await view(
        target,
        entries.map((item) => item.path),
        !done,
      )
      const missing: number[] = []
      for (const [index, item] of entries.entries()) {
        const file = path.join(input.root, "view", item.path)
        if (await optional(file)) await content(file, item)
        else if (done) throw new Error("Completed composition content missing")
        else missing.push(index)
      }
      const size = Buffer.byteLength(JSON.stringify(encoded, null, 2) + "\n")
      let increment = 0
      for (const index of missing)
        increment += (
          await materialization(input.root, path.join(input.root, "view", entries[index].path), data[index])
        ).required
      if (
        (await directoryBytes(input.root)) + (prior ? 0 : size) + (done ? 0 : size) + increment >
        cfg.bounds.archiveBytes
      )
        throw new Error("Composition storage capacity exceeded")
      // 起点只写隔离暂存视图，未提交激活前绝不覆盖当前工作区。
      if (!prior) await writeJsonAtomic(event, encoded)
      for (const index of missing) {
        const file = path.join(input.root, "view", entries[index].path)
        await mkdir(path.dirname(file), { recursive: true })
        await checkedPath(path.dirname(file), "directory")
        await materialize(input.root, file, data[index])
      }
      await view(
        target,
        entries.map((item) => item.path),
        false,
      )
      if (!done) await writeJsonAtomic(completed, encoded)
      return immutable({
        id,
        record,
        path: completed.replaceAll("\\", "/"),
        view: path.join(input.root, "view").replaceAll("\\", "/"),
      })
    },
    cfg.bounds.archiveBytes,
  )
}
