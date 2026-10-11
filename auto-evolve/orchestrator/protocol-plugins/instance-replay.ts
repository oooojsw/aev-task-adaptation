import path from "node:path"
import { loadLongTaskSpec } from "../long-task/spec"
import { pathExists } from "../fs"
import { deriveEntry } from "./derive-entry"
import { runEntry, prepareEntry, validateEntry } from "./entry"
import { selectedRuntime } from "./selected-runtime"
import type { Runtime } from "./runtime"
import { readFile } from "node:fs/promises"
import { freezeDeployment } from "./deployment"

export class ProtocolReplayFault extends Error {}

export async function instanceReplay(input: { cwd: string; sourceTaskRoot: string; parentRunRoot?: string;
  candidateRoot: string; slotDir: string; role: "train" | "test"; deploymentRoot?: string }, injected?: Runtime) {
  const specPath = path.join(input.sourceTaskRoot, "spec.json")
  const frozenParent = input.parentRunRoot && await pathExists(path.join(input.parentRunRoot, "protocol-plugins", "entry.snapshot.json"))
  if (!await pathExists(specPath)) {
    if (frozenParent) throw new ProtocolReplayFault("Protocol source spec missing; no legacy replay fallback")
    return undefined
  }
  const raw = JSON.parse((await readFile(specPath, "utf8")).replace(/^\uFEFF/, ""))
  if (!raw.protocolPlugins) {
    if (frozenParent || Object.hasOwn(raw, "protocolPlugins")) throw new ProtocolReplayFault("Protocol entry removed or invalid; no legacy replay fallback")
    return undefined
  }
  try {
  const { spec } = await loadLongTaskSpec(specPath, { allowMissingInitialExpertContextPaths: true })
  if (!spec.protocolPlugins) return undefined
  if (!input.parentRunRoot) throw new Error("Explicit frozen parent run required for protocol replay")
  const runtime = injected ?? await selectedRuntime(path.join(input.slotDir, "protocol-backends"), input.cwd, spec.protocolPlugins)
  const parentEntry = validateEntry(JSON.parse((await readFile(path.join(input.parentRunRoot, "protocol-plugins", "entry.snapshot.json"), "utf8"))
    .replace(/^\uFEFF/, "")).entry)
  if (spec.protocolPlugins.phase !== (input.role === "test" ? "test" : "source")) throw new Error("Replay role and selected source/test phase mismatch")
  const parent = await prepareEntry(input.parentRunRoot, parentEntry, runtime)
  const requested = await prepareEntry(path.join(input.slotDir, "requested-protocol"), spec.protocolPlugins, runtime)
  if (!parent || !requested || parent.project.fingerprint !== requested.project.fingerprint ||
      parent.protocol.fingerprint !== requested.protocol.fingerprint) throw new Error("Requested replay/test protocol differs from frozen parent")
  const deployment = input.role === "test" ? { root: input.deploymentRoot!, candidateRoot: input.candidateRoot,
    parentRunRoot: input.parentRunRoot, project: parent.project, protocolFingerprint: parent.protocol.fingerprint } : undefined
  if (deployment) await freezeDeployment(deployment)
  const runRoot = path.join(input.slotDir, "protocol-run")
  // 测试题没有来源Campaign；父血统来自冻结合并，任务身份仍由测试协议指定。
  const entry = await deriveEntry({ parentRunRoot: input.parentRunRoot, parentEntry,
    runRoot, phase: input.role === "test" ? "test" : "replay", taskID: spec.protocolPlugins.taskID, runtime })
  const receipt = await runEntry(runRoot, entry, input.candidateRoot, path.join(runRoot, "attempt"), runtime, { reuseCompleted: true })
  if (deployment) await freezeDeployment(deployment)
  return { receipt, runRoot, passed: receipt.status === "passed",
    infrastructureFailure: !["passed", "rejected"].includes(receipt.status) }
  } catch (cause) {
    throw new ProtocolReplayFault("Protocol replay stopped; inspect frozen entry and attempt evidence", { cause })
  }
}
