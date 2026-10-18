import { createHash } from "node:crypto"
import { lstat, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { writeFileAtomic, writeJsonAtomic } from "../../atomic-write"
import { checkedPath, directoryBytes, withFileTransaction } from "../../file-transaction"
import { canonical, fingerprint, immutable } from "../../protocol-plugins/identity"
import { resolveResource } from "../binding"

export interface ArchiveScope {
  campaign: string
  plan: string
  protocol: string
  policy: string
  budget: { root: string; scope: string }
}

interface Entry {
  id: string
  path: string
  bytes: number
  sha256: string
}
interface Feedback {
  path: string
  bytes: number
  sha256: string
  status: "passed" | "rejected"
}
export interface ArchiveInput {
  root: string
  candidateRoot: string
  evidenceRoot: string
  scope: ArchiveScope
  round: number
  pass: number
  branch: "original" | "alternative"
  parent: string | null
  closure: string | null
  entries: Entry[]
  feedback: Feedback | null
  metric?: number
  bounds: { archiveBytes: number; candidateBytes: number }
  recover?: boolean
}

interface RecordBody {
  schema: "aev.exploration-candidate.v1"
  scope: ArchiveScope
  round: number
  pass: number
  branch: "original" | "alternative"
  parent: string | null
  closure: string | null
  files: Array<Entry & { file: string }>
  feedback: (Feedback & { file: string }) | null
  metric?: number
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

async function optional(file: string) {
  try {
    return await checkedPath(file, "file")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function bytes(file: string, expected: { bytes: number; sha256: string }, cap: number) {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > cap || !digest(expected.sha256)) {
    throw new Error("Invalid archive file bounds or identity")
  }
  const before = await checkedPath(file, "file")
  if (before.size !== expected.bytes) throw new Error("Archive source size drift")
  const data = await readFile(file)
  const after = await checkedPath(file, "file")
  if (
    before.ino !== after.ino ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    data.length !== expected.bytes ||
    hash(data) !== expected.sha256
  )
    throw new Error("Archive file identity drift")
  return data
}

function body(input: ArchiveInput): RecordBody {
  const scope = input.scope
  if (
    typeof scope?.campaign !== "string" ||
    !scope.campaign.trim() ||
    typeof scope.budget?.scope !== "string" ||
    !scope.budget.scope.trim() ||
    !path.isAbsolute(scope.budget.root) ||
    ![scope.plan, scope.protocol, scope.policy].every(digest) ||
    !["original", "alternative"].includes(input.branch) ||
    !Number.isSafeInteger(input.round) ||
    input.round < 0 ||
    !Number.isSafeInteger(input.pass) ||
    input.pass < 0 ||
    (input.parent !== null && !digest(input.parent)) ||
    (input.closure !== null && !digest(input.closure)) ||
    (input.round === 0
      ? input.pass !== 0 ||
        input.feedback !== null ||
        input.closure !== null ||
        input.branch !== "original" ||
        input.metric !== undefined ||
        input.parent !== null
      : input.pass < 1 || !input.feedback || !input.closure) ||
    (input.metric !== undefined && !Number.isFinite(input.metric)) ||
    !Array.isArray(input.entries) ||
    !input.entries.length ||
    new Set(input.entries.map((item) => item.id)).size !== input.entries.length ||
    new Set(input.entries.map((item) => item.path.toLowerCase())).size !== input.entries.length
  )
    throw new Error("Invalid archive identity")
  if (input.feedback && (!["passed", "rejected"].includes(input.feedback.status) || !digest(input.feedback.sha256)))
    throw new Error("Invalid archive feedback")
  for (const value of Object.values(input.bounds))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Finite archive bounds required")
  let size = 0
  for (const item of input.entries) {
    if (
      typeof item.id !== "string" ||
      !item.id.trim() ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      !digest(item.sha256)
    )
      throw new Error("Invalid archive entry")
    size += item.bytes
  }
  if (!Number.isSafeInteger(size) || size > input.bounds.candidateBytes)
    throw new Error("Candidate archive capacity exceeded")
  return {
    schema: "aev.exploration-candidate.v1",
    scope: structuredClone(scope),
    round: input.round,
    pass: input.pass,
    branch: input.branch,
    parent: input.parent,
    closure: input.closure,
    files: input.entries.map((item, index) => ({
      id: item.id,
      path: item.path,
      bytes: item.bytes,
      sha256: item.sha256,
      file: `files/${index}.bin`,
    })),
    feedback: input.feedback
      ? {
          path: input.feedback.path,
          bytes: input.feedback.bytes,
          sha256: input.feedback.sha256,
          status: input.feedback.status,
          file: "feedback.bin",
        }
      : null,
    ...(input.metric === undefined ? {} : { metric: input.metric }),
  }
}

export async function saveCandidate(input: ArchiveInput) {
  const record = body(input),
    id = fingerprint(record)
  if (![input.root, input.candidateRoot, input.evidenceRoot].every(path.isAbsolute))
    throw new Error("Absolute archive roots required")
  await checkedPath(input.candidateRoot, "directory")
  await checkedPath(input.evidenceRoot, "directory")
  const content = []
  for (const item of record.files)
    content.push(await bytes(await resolveResource(input.candidateRoot, item.path), item, input.bounds.candidateBytes))
  if (record.feedback)
    content.push(
      await bytes(
        await resolveResource(input.evidenceRoot, record.feedback.path),
        record.feedback,
        input.bounds.archiveBytes,
      ),
    )
  await mkdir(input.root, { recursive: true })
  await checkedPath(input.root, "directory")
  return withFileTransaction(
    input.root,
    "archive",
    async () => {
      if (record.parent) {
        const parent = await readCandidate(input.root, record.parent, input.scope, input.bounds.archiveBytes)
        if (parent.record.round >= record.round) throw new Error("Archive parent must precede child round")
      }
      const dir = path.join(input.root, id),
        intent = path.join(input.root, `${id}.intent.json`),
        completed = path.join(dir, "record.json")
      const event = { schema: "aev.exploration-archive-event.v1", scope: record.scope, round: record.round }
      const key = fingerprint(event),
        eventPath = path.join(input.root, `${key}.event.json`)
      const prior = await optional(eventPath)
      if (prior) {
        if (prior.size > input.bounds.archiveBytes) throw new Error("Archive event capacity exceeded")
        const saved = JSON.parse((await readFile(eventPath, "utf8")).replace(/^\uFEFF/, ""))
        if (canonical(saved.event) !== canonical(event) || saved.candidate !== id)
          throw new Error("Archive event input drift")
      } else if (input.recover) throw new Error("Archive recovery event missing")
      const saved = await optional(completed)
      if (saved) {
        if (!prior) throw new Error("Completed archive missing event binding")
        const actual = await readCandidate(input.root, id, input.scope, input.bounds.archiveBytes)
        if (canonical(actual.record) !== canonical(record)) throw new Error("Archive record conflict")
        return actual
      }
      const pending = await optional(intent)
      if (prior && !input.recover) throw new Error("Incomplete archive requires explicit recovery")
      if (pending) {
        if (!input.recover) throw new Error("Incomplete archive requires explicit recovery")
        if (pending.size > input.bounds.archiveBytes) throw new Error("Archive intent capacity exceeded")
        const saved = JSON.parse((await readFile(intent, "utf8")).replace(/^\uFEFF/, ""))
        if (saved.fingerprint !== id || canonical(saved.record) !== canonical(record))
          throw new Error("Archive intent drift")
      } else {
        try {
          await lstat(dir)
          throw new Error("Archive directory missing bound intent; inspect before recovery")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      const targets = [...record.files, ...(record.feedback ? [record.feedback] : [])]
      const missing: number[] = []
      for (const [index, item] of targets.entries()) {
        const file = path.join(dir, item.file)
        if (await optional(file)) await bytes(file, item, input.bounds.archiveBytes)
        else missing.push(index)
      }
      const encoded = Buffer.byteLength(JSON.stringify({ fingerprint: id, record }, null, 2) + "\n")
      const eventBytes = Buffer.byteLength(JSON.stringify({ event, candidate: id }, null, 2) + "\n")
      // 同锁核算全档案及缺失写入；空间不足保留现场，不删旧证据。
      if (
        (await directoryBytes(input.root)) +
          (prior ? 0 : eventBytes) +
          encoded * (pending ? 1 : 2) +
          missing.reduce((sum, index) => sum + content[index].length, 0) >
        input.bounds.archiveBytes
      ) {
        throw new Error("Exploration archive storage capacity exceeded")
      }
      if (!prior) await writeJsonAtomic(eventPath, { event, candidate: id })
      if (!pending) {
        await writeJsonAtomic(intent, { fingerprint: id, record })
      }
      await mkdir(dir, { recursive: true })
      await checkedPath(dir, "directory")
      await mkdir(path.join(dir, "files"), { recursive: true })
      await checkedPath(path.join(dir, "files"), "directory")
      for (const index of missing) await writeFileAtomic(path.join(dir, targets[index].file), content[index])
      await writeJsonAtomic(completed, { fingerprint: id, record })
      return readCandidate(input.root, id, input.scope, input.bounds.archiveBytes)
    },
    input.bounds.archiveBytes,
  )
}

export async function readCandidate(root: string, id: string, scope: ArchiveScope, cap: number) {
  if (!digest(id) || !Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid archive read identity")
  await checkedPath(root, "directory")
  const dir = path.join(root, id)
  const file = await resolveResource(root, `${id}/record.json`)
  if ((await checkedPath(file, "file")).size > cap) throw new Error("Archive record capacity exceeded")
  const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as {
    fingerprint: string
    record: RecordBody
  }
  if (
    saved.fingerprint !== id ||
    fingerprint(saved.record) !== id ||
    canonical(saved.record.scope) !== canonical(scope) ||
    saved.record.schema !== "aev.exploration-candidate.v1"
  )
    throw new Error("Archive record identity drift")
  const normalized = body({
    ...saved.record,
    root,
    candidateRoot: root,
    evidenceRoot: root,
    entries: saved.record.files.map((item) => ({
      id: item.id,
      path: item.path,
      bytes: item.bytes,
      sha256: item.sha256,
    })),
    feedback: saved.record.feedback
      ? {
          path: saved.record.feedback.path,
          bytes: saved.record.feedback.bytes,
          sha256: saved.record.feedback.sha256,
          status: saved.record.feedback.status,
        }
      : null,
    bounds: { archiveBytes: cap, candidateBytes: cap },
  })
  if (canonical(normalized) !== canonical(saved.record)) throw new Error("Archive record structure drift")
  const event = { schema: "aev.exploration-archive-event.v1", scope: saved.record.scope, round: saved.record.round }
  const eventPath = await resolveResource(root, `${fingerprint(event)}.event.json`)
  if ((await checkedPath(eventPath, "file")).size > cap) throw new Error("Archive event capacity exceeded")
  const bound = JSON.parse((await readFile(eventPath, "utf8")).replace(/^\uFEFF/, ""))
  if (canonical(bound.event) !== canonical(event) || bound.candidate !== id)
    throw new Error("Archive event identity drift")
  if (saved.record.files.reduce((sum, item) => sum + item.bytes, 0) + (saved.record.feedback?.bytes ?? 0) > cap)
    throw new Error("Archive total content capacity exceeded")
  for (const [index, item] of saved.record.files.entries()) {
    if (item.file !== `files/${index}.bin`) throw new Error("Archive blob path drift")
    await bytes(await resolveResource(dir, item.file), item, cap)
  }
  if (saved.record.feedback) {
    if (saved.record.feedback.file !== "feedback.bin") throw new Error("Archive feedback blob path drift")
    await bytes(await resolveResource(dir, "feedback.bin"), saved.record.feedback, cap)
  }
  return immutable({ id, path: file.replaceAll("\\", "/"), record: saved.record })
}
