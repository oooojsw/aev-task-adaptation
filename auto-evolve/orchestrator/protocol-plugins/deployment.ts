import path from "node:path"
import { mkdir, readFile, open, access } from "node:fs/promises"
import { readCandidate } from "./candidate"
import { canonical } from "./identity"
import { writeJsonAtomic } from "../atomic-write"
import type { PackSnapshot } from "./project-pack"

export async function freezeDeployment(input: { root: string; candidateRoot: string; parentRunRoot: string;
  project: PackSnapshot; protocolFingerprint: string }) {
  if (![input.root, input.candidateRoot, input.parentRunRoot].every((value) => typeof value === "string" && path.isAbsolute(value))) throw new Error("Explicit frozen test deployment required")
  const candidate = await readCandidate(input.candidateRoot, input.project.pack.skill)
  const binding = { schema: "aev.protocol-deployment.v1", candidateRoot: input.candidateRoot,
    candidateFingerprint: candidate.fingerprint, parentRunRoot: input.parentRunRoot,
    projectFingerprint: input.project.fingerprint, protocolFingerprint: input.protocolFingerprint }
  await mkdir(input.root, { recursive: true })
  const file = path.join(input.root, "deployment.snapshot.json")
  try {
    const claim = await open(path.join(input.root, "deployment.started.claim"), "wx")
    await claim.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(binding)) throw new Error("Frozen test deployment drift")
    return binding
  }
  // 全测试阶段共享同一指纹，不能逐题悄悄换Skill。
  try { await access(file); throw new Error("Unclaimed deployment snapshot") }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  await writeJsonAtomic(file, binding)
  return binding
}
