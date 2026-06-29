import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { loadConfig } from "../orchestrator/schema"
import { loadLongTaskSpec } from "../orchestrator/long-task/spec"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const autoRoot = path.resolve(import.meta.dir, "..")
const repoRoot = path.dirname(autoRoot)
const smokeRoot = path.join(autoRoot, "runtime-state", "smoke-validation-config-profiles")

const previousSets = process.env.AUTO_EVOLVE_VALIDATION_PROFILE_SETS
const previousProfiles = process.env.AUTO_EVOLVE_VALIDATOR_PROFILES
const previousBlankProfiles = process.env.AUTO_EVOLVE_BLANK_EVAL_VALIDATOR_PROFILES

try {
  await rm(smokeRoot, { recursive: true, force: true })
  await mkdir(smokeRoot, { recursive: true })
  await writeFile(path.join(smokeRoot, "material.txt"), "config profile smoke material", "utf8")

  const config = await loadConfig(repoRoot)
  const standardSet = config.validationConfig.profileSets["skill-structure-standard"]
  assert(standardSet, "config.validationConfig.profileSets must define skill-structure-standard")
  assert(
    standardSet.validatorProfiles.includes("skill-surface/standard-hard-v1"),
    "skill-structure-standard must select skill-surface/standard-hard-v1",
  )

  const specPath = path.join(smokeRoot, "spec.json")
  await writeFile(
    specPath,
    JSON.stringify(
      {
        id: "smoke-validation-config-profiles",
        title: "Smoke validation config profiles",
        goal: "Verify global validationConfig profile-set injection without editing the task spec.",
        materials: [{ path: "material.txt", label: "smoke material" }],
        targetPaths: [{ path: "skill", role: "experience-workspace" }],
        validators: [],
      },
      null,
      2,
    ),
    "utf8",
  )

  process.env.AUTO_EVOLVE_VALIDATION_PROFILE_SETS = "skill-structure-standard"
  process.env.AUTO_EVOLVE_VALIDATOR_PROFILES = ""
  process.env.AUTO_EVOLVE_BLANK_EVAL_VALIDATOR_PROFILES = ""

  const loaded = await loadLongTaskSpec(specPath)
  assert(
    loaded.spec.validatorProfiles?.includes("skill-surface/standard-hard-v1"),
    "global validationConfig profile set should be reflected in loaded spec.validatorProfiles",
  )
  assert(
    loaded.spec.validators.some((validator) => validator.id === "skill-structure-hard"),
    "global validationConfig profile set should inject skill-structure-hard validator",
  )

  process.env.AUTO_EVOLVE_VALIDATION_PROFILE_SETS = "missing-profile-set-for-smoke"
  let threw = false
  try {
    await loadLongTaskSpec(specPath)
  } catch (error) {
    threw = String(error).includes("missing-profile-set-for-smoke")
  }
  assert(threw, "unknown validationConfig profile set should fail fast")

  console.log(
    JSON.stringify(
      {
        passed: true,
        summary: "validation config profile smoke passed",
        cases: ["config profile set is defined", "global profile injection", "unknown profile set fail-fast"],
      },
      null,
      2,
    ),
  )
} finally {
  if (previousSets === undefined) delete process.env.AUTO_EVOLVE_VALIDATION_PROFILE_SETS
  else process.env.AUTO_EVOLVE_VALIDATION_PROFILE_SETS = previousSets
  if (previousProfiles === undefined) delete process.env.AUTO_EVOLVE_VALIDATOR_PROFILES
  else process.env.AUTO_EVOLVE_VALIDATOR_PROFILES = previousProfiles
  if (previousBlankProfiles === undefined) delete process.env.AUTO_EVOLVE_BLANK_EVAL_VALIDATOR_PROFILES
  else process.env.AUTO_EVOLVE_BLANK_EVAL_VALIDATOR_PROFILES = previousBlankProfiles
}
