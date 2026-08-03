import path from "node:path"
import { loadConfig } from "../orchestrator/schema"
import { buildSkillBundle } from "../orchestrator/direct-chat/skill-bundler"
import { runSkillOptNativeEval } from "../orchestrator/skillopt-native-eval/runner"
import type { SkillOptNativeSplit } from "../orchestrator/skillopt-native-eval/contract"

const repoRoot = path.resolve(import.meta.dir, "..", "..")

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function ids(value: string | undefined) {
  return value?.split(",").map((item) => item.trim()).filter(Boolean)
}

const skillRoot = option("--skill-root")
const outDir = option("--out-dir")
if (!skillRoot || !outDir) {
  throw new Error(
    "Usage: bun run auto-evolve/scripts/run-skillopt-native-eval.ts " +
      "--skill-root <dir> --out-dir <dir> [--split train|valid_seen|valid_unseen|all] [--case-ids A,B]",
  )
}
const projectConfig = await loadConfig(repoRoot)
const nativeConfig = projectConfig.skillOptDirectChatConfig
const resolvedOut = path.resolve(outDir)
const bundle = await buildSkillBundle({
  skillRoot: path.resolve(skillRoot),
  outDir: path.join(resolvedOut, "skill-bundle"),
})
const split = (option("--split") ?? "valid_unseen") as SkillOptNativeSplit
if (!["train", "valid_seen", "valid_unseen", "all"].includes(split)) throw new Error(`Unsupported --split: ${split}`)
const result = await runSkillOptNativeEval({
  // Invoking this dedicated entry point is itself the explicit opt-in.
  config: { ...nativeConfig, enabled: true },
  skillPath: bundle.bundlePath,
  split,
  caseIDs: ids(option("--case-ids")),
  outDir: resolvedOut,
})
console.log(JSON.stringify(result, null, 2))
