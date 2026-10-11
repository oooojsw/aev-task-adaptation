import path from "node:path"
import { readFile, realpath, mkdir, lstat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { writeFileAtomic } from "../atomic-write"
import { fingerprint } from "./identity"
import type { ProjectPack } from "./project-pack"

export type SkillBinding = ProjectPack["skill"]

function contained(root: string, resolved: string) {
  const rel = path.relative(root, resolved)
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Candidate path escape")
}

export async function readCandidate(root: string, skill: SkillBinding) {
  if (!path.isAbsolute(root) || !skill?.entries?.length) throw new Error("Explicit candidate binding required")
  const base = await realpath(root)
  const seen = new Set<string>()
  const files = []
  for (const entry of skill.entries) {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || /[\\:]/.test(entry.path) ||
        entry.path.split("/").some((part) => !part || part === "." || part === "..") || seen.has(entry.path)) {
      throw new Error("Invalid declared candidate entry")
    }
    seen.add(entry.path)
    const file = await realpath(path.join(base, entry.path))
    contained(base, file)
    const data = await readFile(file)
    if (!data.length) throw new Error("Empty declared candidate entry")
    files.push({ ...entry, data, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") })
  }
  const metadata = files.map(({ data: _, ...item }) => item)
  return { files, metadata, fingerprint: fingerprint({ format: skill.format, files: metadata }) }
}

export async function hasCandidate(root: string, skill: SkillBinding) {
  try { await readCandidate(root, skill); return true } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}

export async function copyCandidate(source: string, target: string, skill: SkillBinding) {
  if (!path.isAbsolute(target)) throw new Error("Absolute candidate target required")
  // 先读全量声明文件再写，缺入口时不能产生半份“成功”候选。
  const original = await readCandidate(source, skill)
  await mkdir(target, { recursive: true })
  const base = await realpath(target)
  for (const entry of original.files) {
    const destination = path.join(base, entry.path)
    await mkdir(path.dirname(destination), { recursive: true })
    contained(base, await realpath(path.dirname(destination)))
    try {
      if ((await lstat(destination)).isSymbolicLink()) throw new Error("Candidate target link rejected")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }
  for (const entry of original.files) await writeFileAtomic(path.join(base, entry.path), entry.data)
  const copied = await readCandidate(base, skill)
  if (copied.fingerprint !== original.fingerprint) throw new Error("Candidate copy fingerprint mismatch")
  return copied.fingerprint
}
