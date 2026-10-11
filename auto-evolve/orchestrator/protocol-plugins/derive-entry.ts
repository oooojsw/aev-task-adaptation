import path from "node:path"
import { readFile, open } from "node:fs/promises"
import { prepareEntry, validateEntry, type Entry } from "./entry"
import { canonical, fingerprint } from "./identity"
import { writeJsonAtomic } from "../atomic-write"
import type { Runtime } from "./runtime"
import type { Phase } from "./contract"

export async function deriveEntry(input: { parentRunRoot: string; parentEntry: Entry;
  runRoot: string; phase: Exclude<Phase, "source">; taskID: string; runtime: Runtime }) {
  if (!path.isAbsolute(input.parentRunRoot) || !path.isAbsolute(input.runRoot) ||
      path.resolve(input.parentRunRoot) === path.resolve(input.runRoot)) throw new Error("Distinct absolute derived run required")
  if (!["merge", "replay", "test"].includes(input.phase)) throw new Error("Explicit derived phase required")
  // 派生必须来自已冻结父运行，不能把新配置冒充历史来源。
  await readFile(path.join(input.parentRunRoot, "protocol-plugins", "entry.snapshot.json"))
  const parent = await prepareEntry(input.parentRunRoot, input.parentEntry, input.runtime)
  if (!parent) throw new Error("Frozen parent protocol required")
  const entry = validateEntry({ ...parent.entry, phase: input.phase, taskID: input.taskID })
  const derived = await prepareEntry(input.runRoot, entry, input.runtime)
  if (!derived || derived.protocol.fingerprint !== parent.protocol.fingerprint ||
      derived.project.fingerprint !== parent.project.fingerprint) throw new Error("Derived protocol/project identity mismatch")
  const body = { schema: "aev.protocol-lineage.v1", parentRunRoot: input.parentRunRoot,
    parentEntry: parent.entry, entry, projectFingerprint: parent.project.fingerprint,
    protocolFingerprint: parent.protocol.fingerprint }
  const lineage = { ...body, fingerprint: fingerprint(body) }
  const file = path.join(derived.dir, "lineage.json")
  try {
    const claim = await open(path.join(derived.dir, "lineage.started.claim"), "wx")
    await claim.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const previous = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(previous) !== canonical(lineage)) throw new Error("Derived lineage changed")
    return entry
  }
  await writeJsonAtomic(file, lineage)
  return entry
}
