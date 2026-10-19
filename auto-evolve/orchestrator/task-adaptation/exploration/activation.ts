import { createHash } from "node:crypto"
import { readFile, mkdir, lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "../../atomic-write"
import { checkedPath, directoryBytes, withFileTransaction } from "../../file-transaction"
import { canonical, fingerprint, immutable } from "../../protocol-plugins/identity"
import { readCandidate, type ArchiveScope } from "./archive"
import { compose, type CompositionInput } from "./composition"
import { materialize, materialization, overlaps } from "./materialize"
import { explorationIdentity, explorationPolicy } from "./policy"

interface ActivationInput {
  root: string
  composition: CompositionInput
  recover?: boolean
}

interface State {
  schema: "aev.exploration-activation.v1"
  scope: ArchiveScope
  generation: 1
  previous: 0
  composition: string
  view: string
  origin: string
  current: string
}

async function saved(root: string, name: string, cap: number) {
  const file = path.join(root, name)
  try {
    const stat = await checkedPath(file, "file")
    if (stat.size > cap) throw new Error("Activation record capacity exceeded")
    const data = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    if (fingerprint(data.record) !== data.fingerprint) throw new Error("Activation record identity drift")
    return data as { fingerprint: string; record: State }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function state(record: State, scope: ArchiveScope, root: string) {
  if (
    record.schema !== "aev.exploration-activation.v1" ||
    record.generation !== 1 ||
    record.previous !== 0 ||
    canonical(record.scope) !== canonical(scope) ||
    record.view !== path.join(root, "work").replaceAll("\\", "/") ||
    ![record.composition, record.origin, record.current].every(
      (item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item),
    )
  )
    throw new Error("Activation scope or generation drift")
}

async function bind(root: string, scope: ArchiveScope, cap: number) {
  if (
    !scope ||
    typeof scope.campaign !== "string" ||
    !scope.campaign.trim() ||
    ![scope.plan, scope.policy, scope.protocol].every(
      (item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item),
    ) ||
    !scope.budget ||
    !path.isAbsolute(scope.budget.root) ||
    typeof scope.budget.scope !== "string" ||
    !scope.budget.scope.trim()
  )
    throw new Error("Invalid generation scope")
  const file = path.join(root, "generation.scope.json")
  const value = { schema: "aev.exploration-generation-scope.v1", root: path.resolve(root).replaceAll("\\", "/"), scope }
  try {
    const stat = await checkedPath(file, "file")
    if (
      stat.size > cap ||
      canonical(JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))) !== canonical(value)
    )
      throw new Error("Generation scope binding drift")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    for (const name of ["activation.intent.json", "activation.json"]) {
      if (await saved(root, name, cap)) throw new Error("Existing activation missing scope binding")
    }
    if ((await directoryBytes(root)) + Buffer.byteLength(JSON.stringify(value, null, 2) + "\n") > cap)
      throw new Error("Generation scope storage capacity exceeded")
    await writeJsonAtomic(file, value)
  }
}

export async function activate(input: ActivationInput) {
  const policy = explorationPolicy(input.composition.policy, input.composition.bound.plan)!
  if (
    input.composition.scope.plan !== input.composition.bound.fingerprint ||
    input.composition.scope.policy !== explorationIdentity(policy, input.composition.bound.plan)
  )
    throw new Error("Activation composition binding mismatch")
  if (
    !path.isAbsolute(input.root) ||
    overlaps(input.root, input.composition.root) ||
    overlaps(input.root, input.composition.archive) ||
    overlaps(input.root, input.composition.bound.root)
  )
    throw new Error("Separate absolute activation root required")
  await mkdir(input.root, { recursive: true })
  const cap = input.composition.policy.bounds.archiveBytes
  return withFileTransaction(
    input.root,
    "activation",
    async () => {
      await bind(input.root, input.composition.scope, cap)
      const prepared = await compose(input.composition)
      const record: State = {
        schema: "aev.exploration-activation.v1",
        scope: input.composition.scope,
        generation: 1,
        previous: 0,
        composition: prepared.id,
        view: path.join(input.root, "work").replaceAll("\\", "/"),
        origin: input.composition.origin,
        current: input.composition.current,
      }
      const encoded = { fingerprint: fingerprint(record), record }
      const intent = await saved(input.root, "activation.intent.json", cap)
      const committed = await saved(input.root, "activation.json", cap)
      for (const item of [intent, committed]) {
        if (!item) continue
        state(item.record, input.composition.scope, input.root)
        if (canonical(item) !== canonical(encoded)) throw new Error("Activation input drift")
      }
      if (committed) {
        if (!intent) throw new Error("Activation commit missing intent")
        await checkedPath(committed.record.view, "directory")
        return immutable(encoded)
      }
      if (intent && !input.recover) throw new Error("Incomplete activation requires explicit recovery")
      if (!intent && input.recover) throw new Error("Activation recovery intent missing")
      // 持有同一读写屏障后复核切前正文，防止准备期间的新修改丢失。
      const current = await readCandidate(
        input.composition.archive,
        input.composition.current,
        input.composition.scope,
        cap,
      )
      for (const item of current.record.files) {
        const file = path.join(input.composition.bound.root, item.path)
        await checkedPath(file, "file")
        const bytes = await readFile(file)
        if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
          throw new Error("Activation pre-switch candidate drift")
      }
      const entries = [...prepared.record.files, ...prepared.record.dependencies]
      const missing: typeof entries = []
      async function walk(dir: string, prefix: string) {
        for (const name of await readdir(dir)) {
          const file = path.join(dir, name),
            relative = prefix + name
          const stat = await lstat(file)
          if (stat.isDirectory()) {
            await checkedPath(file, "directory")
            if (!entries.some((item) => item.path.startsWith(`${relative}/`)))
              throw new Error("Unexpected activation directory")
            await walk(file, `${relative}/`)
          } else {
            await checkedPath(file, "file")
            if (!entries.some((item) => item.path === relative)) throw new Error("Unexpected activation file")
          }
        }
      }
      try {
        await checkedPath(record.view, "directory")
        if (!intent) throw new Error("Unclaimed activation workspace")
        await walk(record.view, "")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      for (const item of entries) {
        try {
          const file = path.join(record.view, item.path)
          await checkedPath(file, "file")
          const bytes = await readFile(file)
          if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
            throw new Error("Activation workspace drift")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          missing.push(item)
        }
      }
      const size = Buffer.byteLength(JSON.stringify(encoded, null, 2) + "\n")
      let increment = 0
      for (const item of missing) {
        const bytes = await readFile(path.join(prepared.view, item.path))
        increment += (await materialization(input.root, path.join(record.view, item.path), bytes)).required
      }
      if ((await directoryBytes(input.root)) + size * (intent ? 1 : 2) + increment > cap)
        throw new Error("Activation storage capacity exceeded")
      if (!intent) await writeJsonAtomic(path.join(input.root, "activation.intent.json"), encoded)
      for (const item of missing) {
        const file = path.join(record.view, item.path)
        const bytes = await readFile(path.join(prepared.view, item.path))
        if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
          throw new Error("Prepared activation bytes drift")
        await mkdir(path.dirname(file), { recursive: true })
        await checkedPath(path.dirname(file), "directory")
        await materialize(input.root, file, bytes)
      }
      // 单一原子指针提交消费重启机会；正文仍在独立视图，不逐文件覆盖current。
      await writeJsonAtomic(path.join(input.root, "activation.json"), encoded)
      return immutable(encoded)
    },
    cap,
  )
}

export async function withGeneration<T>(
  input: {
    root: string
    scope: ArchiveScope
    generation: 0 | 1
    cap: number
  },
  fn: (state: Readonly<State> | undefined) => Promise<T>,
): Promise<T> {
  if (!path.isAbsolute(input.root) || ![0, 1].includes(input.generation)) throw new Error("Invalid generation lease")
  await mkdir(input.root, { recursive: true })
  return withFileTransaction(
    input.root,
    "activation",
    async () => {
      await bind(input.root, input.scope, input.cap)
      const intent = await saved(input.root, "activation.intent.json", input.cap)
      const committed = await saved(input.root, "activation.json", input.cap)
      // 未完成切换时所有入口阻断，先恢复，不能让旧调用继续写。
      if (intent && !committed) throw new Error("Activation pending recovery")
      if (committed) {
        state(committed.record, input.scope, input.root)
        if (!intent || canonical(intent) !== canonical(committed)) throw new Error("Activation intent mismatch")
        await checkedPath(committed.record.view, "directory")
      }
      if ((committed?.record.generation ?? 0) !== input.generation) throw new Error("Stale exploration generation")
      // 调用者须在返回前结束全部子任务；屏障不能撤销脱离回调的外部副作用。
      return fn(committed ? immutable(committed.record) : undefined)
    },
    input.cap,
  )
}
