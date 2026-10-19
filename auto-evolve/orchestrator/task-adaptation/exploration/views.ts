import { readFile } from "node:fs/promises"
import path from "node:path"
import { writeFileAtomic, writeJsonAtomic } from "../../atomic-write"
import { checkedPath } from "../../file-transaction"
import { canonical, fingerprint } from "../../protocol-plugins/identity"
import { assertTaskCampaignControl, type TaskCampaignControl } from "./ownership"

// 旧证据保存在意图中；新分支只清局部判断，不改历史账本。
export async function resetTaskBranchViews(input: { root: string; control: TaskCampaignControl; activation: string; round: number; cap: number }) {
  assertTaskCampaignControl(input.control, input.root)
  const root = path.join(input.root, "task-adaptation/exploration/host")
  const intent = path.join(root, "local-views.intent.json"), complete = path.join(root, "local-views.json")
  const scope = { activation: input.activation, scope: input.control.scope, round: input.round }
  const load = async (file: string) => {
    try {
      if ((await checkedPath(file, "file")).size > input.cap) throw new Error("Branch views exceed capacity")
      return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
  }
  const prior = await load(intent)
  const timestamp = prior?.record?.timestamp ?? new Date().toISOString()
  const base = { updatedAt: timestamp, updatedThroughRound: input.round - 1 }
  const replacements = {
    "campaign-operational-memory.json": [],
    "campaign-working-memory.json": { ...base, items: [] },
    "dispatch-tickets.json": { ...base, tickets: [] },
    "routing-control.json": { ...base, currentPhase: "alternative", requiredNextRegions: [], forbiddenUnits: [],
      forbiddenRegions: [], prerequisites: [], blockedBy: [], readyForFinalAcceptance: false, evidenceRefs: [] },
    "exploration-tree.json": { ...base, currentPhase: "alternative", branchSummaries: [], rolePositions: [], frontierRegions: [],
      requiredNextRegions: [], forbiddenRepeatRegions: [], nodes: [] },
    "blank-agent-acceptance-diagnosis.json": { id: "alternative-no-diagnosis", roundNumber: input.round - 1,
      role: "blank_acceptance_diagnostician", createdAt: timestamp, summary: "New branch has no current acceptance diagnosis.",
      findings: [], memoryAdvice: [], packageAdvice: [], explorationAdvice: [], refs: [] },
  }
  const files = []
  if (!prior) for (const [name, value] of Object.entries(replacements)) {
    const file = path.join(input.root, name)
    let before: string | null = null
    try {
      if ((await checkedPath(file, "file")).size > input.cap) throw new Error("Branch history exceeds capacity")
      before = (await readFile(file)).toString("base64")
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    files.push({ name, before, after: JSON.stringify(value, null, 2) + "\n" })
  }
  const record = prior?.record ?? { schema: "aev.exploration-local-views.v1", ...scope, timestamp, files }
  const encoded = { fingerprint: fingerprint(record), record }
  if (canonical({ activation: record.activation, scope: record.scope, round: record.round }) !== canonical(scope) ||
    prior && prior.fingerprint !== encoded.fingerprint) throw new Error("Branch views identity drift")
  if (record.schema !== "aev.exploration-local-views.v1" || !Array.isArray(record.files) ||
    canonical(record.files.map((item: { name: string }) => item.name)) !== canonical(Object.keys(replacements)))
    throw new Error("Branch local view file mapping drift")
  if (Buffer.byteLength(JSON.stringify(encoded)) > input.cap) throw new Error("Branch views exceed capacity")
  const saved = await load(complete)
  if (saved) {
    if (canonical(saved) !== canonical(encoded)) throw new Error("Branch views completion drift")
    return
  }
  if (!prior) await writeJsonAtomic(intent, encoded)
  for (const item of record.files as Array<{ name: string; before: string | null; after: string }>) {
    const file = path.join(input.root, item.name)
    let current: Buffer | undefined
    try { await checkedPath(file, "file"); current = await readFile(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (current?.equals(Buffer.from(item.after))) continue
    if (item.before === null ? current !== undefined : !current?.equals(Buffer.from(item.before, "base64")))
      throw new Error("Branch local view changed during activation")
    await writeFileAtomic(file, item.after)
  }
  await writeJsonAtomic(complete, encoded)
}
