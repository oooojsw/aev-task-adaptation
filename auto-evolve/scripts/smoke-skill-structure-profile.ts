import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { loadLongTaskSpec } from "../orchestrator/long-task/spec"
import { runValidationStage } from "../orchestrator/validation-engine/stage-runner"
import type { AutoEvolveConfig } from "../orchestrator/schema"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const autoEvolveRoot = path.resolve(import.meta.dir, "..")
const cwd = path.dirname(autoEvolveRoot)
const smokeRoot = path.join(autoEvolveRoot, "runtime-state", "smoke-skill-structure-profile")
const skillRoot = path.join(smokeRoot, "skill")
const validatorPath = path.join(autoEvolveRoot, "scripts", "validate-skill-structure-profile.ts")
const materialPath = path.join(smokeRoot, "material.txt")
const profilePath = path.join(smokeRoot, "profile.json")
const payloadPath = path.join(smokeRoot, "validator-input.json")

async function writeJson(pathValue: string, value: unknown) {
  await mkdir(path.dirname(pathValue), { recursive: true })
  await writeFile(pathValue, JSON.stringify(value, null, 2), "utf8")
}

async function writeText(pathValue: string, value: string) {
  await mkdir(path.dirname(pathValue), { recursive: true })
  await writeFile(pathValue, value, "utf8")
}

async function writeProfile() {
  await writeJson(profilePath, {
    id: "smoke.skill-structure",
    rootRoles: ["experience-workspace"],
    closedWorld: true,
    requiredDirs: ["casebook"],
    allowedGlobs: ["casebook/*.md"],
    files: [
      {
        path: "INDEX.md",
        required: true,
        kind: "markdown",
        requiredHeadings: ["## How To Use", "## Read Order", "## Output Requirements"],
      },
      {
        path: "CORE.md",
        required: true,
        kind: "markdown",
        requiredHeadings: ["## Material Navigation Rules", "## Output Discipline"],
      },
      {
        path: "meta.json",
        required: true,
        kind: "json",
        requiredKeys: ["schema", "profileID", "createdAt"],
      },
      {
        path: "surface_contract.json",
        required: true,
        kind: "json",
        requiredKeys: ["version", "entry", "documents"],
      },
    ],
  })
  await writeJson(payloadPath, {
    targetPaths: [{ path: skillRoot, label: "expert workspace", role: "experience-workspace" }],
  })
}

async function writeGoodSkill() {
  await rm(skillRoot, { recursive: true, force: true })
  await writeText(
    path.join(skillRoot, "INDEX.md"),
    [
      "# Index",
      "",
      "## How To Use",
      "Read CORE.md first.",
      "",
      "## Read Order",
      "INDEX.md then CORE.md then matching casebook notes.",
      "",
      "## Output Requirements",
      "Write only the task output requested by the task.",
    ].join("\n"),
  )
  await writeText(
    path.join(skillRoot, "CORE.md"),
    [
      "# Core",
      "",
      "## Material Navigation Rules",
      "Locate source materials first.",
      "",
      "## Output Discipline",
      "Write the expected output file only.",
    ].join("\n"),
  )
  await writeJson(path.join(skillRoot, "meta.json"), {
    schema: "smoke",
    profileID: "smoke.skill-structure",
    createdAt: "2026-06-30T00:00:00.000Z",
  })
  await writeJson(path.join(skillRoot, "surface_contract.json"), {
    version: 1,
    entry: "INDEX.md",
    documents: [
      { path: "INDEX.md", role: "entry" },
      { path: "CORE.md", role: "core" },
    ],
  })
  await writeText(path.join(skillRoot, "casebook", "generic-method.md"), "# Generic Method\n")
}

async function runValidator() {
  const child = Bun.spawn([process.execPath, "run", validatorPath, payloadPath, "--profile", profilePath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const parsed = JSON.parse(stdout)
  return { stdout, stderr, exitCode, parsed }
}

async function expectCase(name: string, mutate: () => Promise<void>, shouldPass: boolean, expectedText?: string) {
  await writeGoodSkill()
  await mutate()
  const result = await runValidator()
  assert(result.parsed.passed === shouldPass, `${name}: expected passed=${shouldPass}, got ${result.stdout}`)
  if (shouldPass) {
    assert(result.exitCode === 0, `${name}: expected exit 0, got ${result.exitCode}\n${result.stderr}`)
  } else {
    assert(result.exitCode !== 0, `${name}: expected non-zero exit`)
  }
  if (expectedText) {
    assert(result.stdout.includes(expectedText), `${name}: expected output to include ${expectedText}\n${result.stdout}`)
  }
}

await rm(smokeRoot, { recursive: true, force: true })
await mkdir(smokeRoot, { recursive: true })
await writeProfile()

await expectCase("valid skill", async () => {}, true)
await expectCase("missing required file", async () => {
  await rm(path.join(skillRoot, "CORE.md"), { force: true })
}, false, "missing required file: CORE.md")
await expectCase("missing required heading", async () => {
  await writeText(path.join(skillRoot, "CORE.md"), "# Core\n\n## Output Discipline\nOnly output the answer.")
}, false, "missing required heading: CORE.md -> ## Material Navigation Rules")
await expectCase("closed world extra file", async () => {
  await writeText(path.join(skillRoot, "random-notes.md"), "# Random\n")
}, false, "file not allowed by skill structure profile: random-notes.md")
await expectCase("json missing key", async () => {
  await writeJson(path.join(skillRoot, "meta.json"), {
    schema: "smoke",
    profileID: "smoke.skill-structure",
  })
}, false, "missing required JSON key: meta.json -> createdAt")

const profileDir = path.join(smokeRoot, "profiles")
const structurePath = path.join(profileDir, "structure.json")
const wrapperPath = path.join(profileDir, "wrapper.json")
await writeJson(structurePath, { id: "relative-profile-config", files: [] })
await writeJson(wrapperPath, {
  id: "relative-wrapper",
  validators: [
    {
      id: "relative-structure",
      type: "script",
      title: "Relative structure profile",
      path: "../../../scripts/validate-skill-structure-profile.ts",
      runner: "bun",
      args: ["--profile", "./structure.json"],
      validation: {
        target: "layout",
        stage: "pre_blank",
        answerAccess: "none",
        allowedAudiences: ["lead", "reviewer", "dashboard", "audit"],
      },
    },
  ],
})
await writeText(materialPath, "smoke material")
await writeJson(path.join(smokeRoot, "spec.json"), {
  title: "Smoke relative validator profile",
  goal: "Smoke relative profile args.",
  materials: [{ path: "./material.txt", label: "smoke material" }],
  targetPaths: [{ path: "./skill", role: "experience-workspace" }],
  validatorProfiles: ["profiles/wrapper.json"],
  validators: [],
})
const loaded = await loadLongTaskSpec(path.join(smokeRoot, "spec.json"))
const validator = loaded.spec.validators.find((item) => item.id === "relative-structure")
assert(validator?.type === "script", "relative profile validator was not loaded")
assert(
  validator.args?.includes(structurePath),
  `relative --profile path was not materialized against the validator profile directory: ${JSON.stringify(validator.args)}`,
)
const stageDir = path.join(smokeRoot, "stage-runner")
const bundlePath = path.join(stageDir, "bundle.json")
const stagePayload = {
  targetPaths: [{ path: skillRoot, label: "expert workspace", role: "experience-workspace" }],
}
await writeJson(bundlePath, stagePayload)
const stage = await runValidationStage({
  cwd,
  config: {} as AutoEvolveConfig,
  spec: loaded.spec,
  unit: {
    id: "skill-structure-profile-smoke",
    title: "Skill structure profile smoke",
    goal: "Run the loaded profile validator through the validation stage runner.",
    inputs: [],
    dependsOn: [],
    expectedArtifacts: [skillRoot],
    claim: "The skill surface matches the loaded structure profile.",
    checkPlan: "Run pre_blank layout validation.",
    validatorIDs: loaded.spec.validators.map((item) => item.id),
    retryBudget: 0,
    status: "active",
    attemptCount: 1,
  },
  stage: "pre_blank",
  targets: ["layout"],
  runID: "skill-structure-profile-smoke",
  attempt: 1,
  stageDir,
  bundlePath,
  payload: stagePayload,
  validators: loaded.spec.validators,
})
assert(stage.passed === true, `stage runner profile validation failed: ${stage.summary}`)

console.log(
  JSON.stringify(
    {
      passed: true,
      summary: "skill structure profile smoke passed",
      cases: [
        "valid skill",
        "missing required file",
        "missing required heading",
        "closed world extra file",
        "json missing key",
        "relative profile args",
        "validation stage runner integration",
      ],
    },
    null,
    2,
  ),
)
