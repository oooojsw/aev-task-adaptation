import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { loadLongTaskSpec } from "../orchestrator/long-task/spec"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const autoRoot = path.resolve(import.meta.dir, "..")
const smokeRoot = path.join(autoRoot, "runtime-state", "smoke-paper-review-surface-validator")
const validatorScript = path.join(autoRoot, "scripts", "validate-paper-review-surface-generalization.ts")
const profilePath = path.join(
  autoRoot,
  "task-packs",
  "validator-profiles",
  "paper-review",
  "profiles",
  "surface-generalization-v2.json",
)

async function runValidator(root: string) {
  const inputPath = path.join(root, "..", `${path.basename(root)}-validator-input.json`)
  await writeFile(
    inputPath,
    JSON.stringify(
      {
        targetPaths: [{ path: root, role: "experience-workspace", label: "learned paper-review skill" }],
      },
      null,
      2,
    ),
    "utf8",
  )
  const child = Bun.spawn([process.execPath, "run", validatorScript, inputPath, "--profile", profilePath], {
    cwd: autoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function writeSkill(root: string, files: Record<string, string>) {
  await mkdir(root, { recursive: true })
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relativePath.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, content, "utf8")
  }
}

const previousSets = process.env.AUTO_EVOLVE_VALIDATION_PROFILE_SETS
const previousProfiles = process.env.AUTO_EVOLVE_VALIDATOR_PROFILES
const previousBlankProfiles = process.env.AUTO_EVOLVE_BLANK_EVAL_VALIDATOR_PROFILES

try {
  await rm(smokeRoot, { recursive: true, force: true })
  await mkdir(smokeRoot, { recursive: true })

  const cleanRoot = path.join(smokeRoot, "clean-skill")
  await writeSkill(cleanRoot, {
    "manifest.md": [
      "# Paper Review Skill",
      "",
      "Use the submission PDF to identify contribution, evidence, weaknesses, and venue fit.",
      "Define a generic rating rubric. Borderline means marginal evidence that could become acceptable after revision.",
      "Do not copy any private reference review. Write a fresh review grounded in the submission.",
    ].join("\n"),
  })
  const clean = await runValidator(cleanRoot)
  assert(clean.exitCode === 0, `clean generic skill should pass: ${clean.stdout}\n${clean.stderr}`)

  const rubricRoot = path.join(smokeRoot, "rubric-skill")
  await writeSkill(rubricRoot, {
    "CORE.md": [
      "# Generic Rubric",
      "",
      "Allowed ratings include Strong Accept, Accept, Weak Accept, Borderline, Weak Reject, Reject, and Strong Reject.",
      "Reject means the evidence is too weak or the submission is out of scope.",
      "Use these labels only after reading the submission and checking contribution, evidence, novelty, clarity, and reproducibility.",
    ].join("\n"),
  })
  const rubric = await runValidator(rubricRoot)
  assert(rubric.exitCode === 0, `generic rating rubric should pass: ${rubric.stdout}\n${rubric.stderr}`)

  const outputFormatRoot = path.join(smokeRoot, "output-format-skill")
  await writeSkill(outputFormatRoot, {
    "CORE.md": [
      "# Output Format",
      "",
      "The final answer should include exactly one Paper Rating selected from the standard rubric labels.",
      "Do not preselect the rating; decide it only after reading the submission evidence.",
    ].join("\n"),
  })
  const outputFormat = await runValidator(outputFormatRoot)
  assert(
    outputFormat.exitCode === 0,
    `generic output-format instruction should not be treated as a concrete rating leak: ${outputFormat.stdout}`,
  )

  const leakRoot = path.join(smokeRoot, "leaky-skill")
  await writeSkill(leakRoot, {
    "manifest.md": [
      "# Leaky Paper Review Skill",
      "",
      "For paper-review-1336, SDR-CLIP should be rated Borderline.",
      "The gold review says to focus on RemoteCLIP and GeoRSCLIP table issues.",
    ].join("\n"),
  })
  const leak = await runValidator(leakRoot)
  assert(leak.exitCode === 1, "leaky skill should fail")
  assert(
    leak.stdout.includes("paper-review task id") || leak.stdout.includes("SDR-CLIP"),
    `leaky skill should report task id or paper-specific term: ${leak.stdout}`,
  )

  const fileNameLeakRoot = path.join(smokeRoot, "filename-leak-skill")
  await writeSkill(fileNameLeakRoot, {
    "paper-review-1336.md": "This empty-looking file leaks the task id through its file name.",
  })
  const fileNameLeak = await runValidator(fileNameLeakRoot)
  assert(fileNameLeak.exitCode === 1, "filename task-id leak should fail")
  assert(fileNameLeak.stdout.includes("paper-review task id"), "filename task-id leak should be reported")

  const ratingForcingRoot = path.join(smokeRoot, "rating-forcing-skill")
  await writeSkill(ratingForcingRoot, {
    "CORE.md": "When the current paper has similar evidence, output Borderline as the final answer.",
  })
  const ratingForcing = await runValidator(ratingForcingRoot)
  assert(ratingForcing.exitCode === 1, `rating forcing should fail: ${ratingForcing.stdout}`)
  assert(ratingForcing.stdout.includes("rating forcing"), `rating forcing should be reported: ${ratingForcing.stdout}`)

  const warningOnlyRoot = path.join(smokeRoot, "warning-only-skill")
  await writeSkill(warningOnlyRoot, {
    "CORE.md": "When reading a submission, note whether Table 2 outperforms baselines, then generalize the observation to all baseline tables.",
  })
  const warningOnly = await runValidator(warningOnlyRoot)
  assert(warningOnly.exitCode === 0, `single warning should not block v2: ${warningOnly.stdout}`)
  assert(warningOnly.stdout.includes("[WARN]"), `single warning should be visible: ${warningOnly.stdout}`)

  const materialPath = path.join(smokeRoot, "submission.pdf")
  await writeFile(materialPath, "placeholder", "utf8")
  const specPath = path.join(smokeRoot, "spec.json")
  await writeFile(
    specPath,
    JSON.stringify(
      {
        id: "paper-review-surface-smoke",
        title: "paper-review-surface-smoke",
        goal: "Verify paper-review surface profile set injection.",
        taskFamily: "paper-review-learnbench",
        materials: [{ path: "submission.pdf", label: "submission", role: "source-paper" }],
        targetPaths: [{ path: "expert-workspace", role: "experience-workspace" }],
        validatorProfiles: ["paper-review/train-v1"],
        validators: [],
      },
      null,
      2,
    ),
    "utf8",
  )

  process.env.AUTO_EVOLVE_VALIDATION_PROFILE_SETS = "paper-review-surface-generalization"
  process.env.AUTO_EVOLVE_VALIDATOR_PROFILES = ""
  process.env.AUTO_EVOLVE_BLANK_EVAL_VALIDATOR_PROFILES = ""
  const loaded = await loadLongTaskSpec(specPath)
  assert(
    loaded.spec.validatorProfiles?.includes("paper-review/surface-generalization-v2"),
    "paper-review surface profile set should be reflected in loaded spec.validatorProfiles",
  )
  assert(
    loaded.spec.validators.some((validator) => validator.id === "paper-review-surface-generalization-hard-v2"),
    "paper-review surface profile set should inject hard surface validator",
  )

  const specV2Path = path.join(smokeRoot, "spec-v2.json")
  await writeFile(
    specV2Path,
    JSON.stringify(
      {
        id: "paper-review-train-v2-smoke",
        title: "paper-review-train-v2-smoke",
        goal: "Verify paper-review train-v2 includes surface and product validators.",
        taskFamily: "paper-review-learnbench",
        materials: [{ path: "submission.pdf", label: "submission", role: "source-paper" }],
        targetPaths: [{ path: "expert-workspace", role: "experience-workspace" }],
        validatorProfiles: ["paper-review/train-v2"],
        validators: [],
      },
      null,
      2,
    ),
    "utf8",
  )
  process.env.AUTO_EVOLVE_VALIDATION_PROFILE_SETS = ""
  const loadedV2 = await loadLongTaskSpec(specV2Path)
  const validatorIDs = loadedV2.spec.validators.map((validator) => validator.id)
  assert(validatorIDs.includes("paper-review-surface-generalization-hard-v2"), "train-v2 should include surface validator")
  assert(validatorIDs.includes("paper-review-hard-check"), "train-v2 should include hard product validator")
  assert(validatorIDs.includes("paper-review-quality-soft"), "train-v2 should include soft product validator")

  console.log(
    JSON.stringify(
      {
        passed: true,
        summary: "paper-review surface validator smoke passed",
        cases: [
          "clean generic skill passes",
          "generic rating rubric passes",
          "generic output-format instruction passes",
          "task id / paper-specific / gold leak fails",
          "filename task id leak fails",
          "rating forcing context fails",
          "single warning remains non-blocking",
          "global profile set injects surface validator",
          "paper-review/train-v2 includes surface and product validators",
        ],
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
