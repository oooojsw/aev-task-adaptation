import path from "node:path"
import { loadLongTaskSpec } from "../long-task/spec"
import { pathExists } from "../fs"
import { deriveEntry } from "./derive-entry"
import { runEntry } from "./entry"
import { selectedRuntime } from "./selected-runtime"
import type { Runtime } from "./runtime"
import { readFile } from "node:fs/promises"

export class ProtocolReplayFault extends Error {}

export async function instanceReplay(input: { cwd: string; sourceTaskRoot: string; parentRunRoot?: string;
  candidateRoot: string; slotDir: string; role: "train" | "test" }, injected?: Runtime) {
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
  const runRoot = path.join(input.slotDir, "protocol-run")
  const entry = await deriveEntry({ parentRunRoot: input.parentRunRoot, parentEntry: spec.protocolPlugins,
    runRoot, phase: input.role === "test" ? "test" : "replay", taskID: spec.protocolPlugins.taskID, runtime })
  const receipt = await runEntry(runRoot, entry, input.candidateRoot, path.join(runRoot, "attempt"), runtime, { reuseCompleted: true })
  return { receipt, runRoot, passed: receipt.status === "passed",
    infrastructureFailure: !["passed", "rejected"].includes(receipt.status) }
  } catch (cause) {
    throw new ProtocolReplayFault("Protocol replay stopped; inspect frozen entry and attempt evidence", { cause })
  }
}
