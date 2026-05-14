import path from "node:path"
import { cp, readdir, rm, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { ensureDirectory, pathExists, readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "./fs"
import { loadConfig } from "./schema"
import { runOpencodeTask, type OpencodeTaskRun } from "./opencode"
import { runManagedProcess, type ManagedProcessResult } from "./managed-process"
import { runLongTask } from "./long-task/runner"

export type SkillsBenchMode = "short" | "long"

export interface SkillsBenchRunOptions {
  cwd: string
  root: string
  taskID: string
  mode: SkillsBenchMode
  attempts?: number
  timeoutMs?: number
  skipDockerBuild?: boolean
}

export interface SkillsBenchVerifierResult {
  passed: boolean
  summary: string
  details: string[]
  logsDir: string
  imageTag: string
  failureKind?: "task_failure" | "verifier_infrastructure" | "docker_build_failure"
  build?: ManagedProcessResult
  run: ManagedProcessResult
}

interface PreparedSkillsBenchTask {
  taskID: string
  taskRoot: string
  instructionPath: string
  workDir: string
  logsDir: string
  specDir: string
  runRoot: string
  imageTag: string
  instruction: string
}

function nowStamp() {
  const date = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds(), 3),
  ].join("")
}

function safeID(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skillsbench-task"
  )
}

function dockerImageTag(taskID: string) {
  return `auto-evolve-skillsbench-${safeID(taskID)}:${nowStamp().toLowerCase()}`
}

function parseTaskTimeoutMs(taskToml: string, key: "agent" | "verifier", fallbackMs: number) {
  const sectionMatch = taskToml.match(new RegExp(`\\[${key}\\]([\\s\\S]*?)(?:\\n\\[|$)`, "m"))
  const section = sectionMatch?.[1] ?? ""
  const timeoutMatch = section.match(/timeout_sec\s*=\s*([0-9]+(?:\.[0-9]+)?)/)
  const seconds = timeoutMatch ? Number(timeoutMatch[1]) : Number.NaN
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : fallbackMs
}

async function copyEnvironmentWithoutLeaks(source: string, target: string) {
  await ensureDirectory(target)
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const lower = entry.name.toLowerCase()
    if (lower === ".git" || lower === "__pycache__" || lower === "groundtruth" || lower === "ground_truth") continue
    if (lower === "answers.txt" || lower === "answer.txt" || lower === "solution.json") continue

    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      await copyEnvironmentWithoutLeaks(sourcePath, targetPath)
    } else if (entry.isFile()) {
      await cp(sourcePath, targetPath, { force: true })
    }
  }
}

async function prepareSkillsBenchTask(input: SkillsBenchRunOptions): Promise<PreparedSkillsBenchTask> {
  const root = path.resolve(input.root)
  const taskRoot = path.join(root, "tasks", input.taskID)
  const instructionPath = path.join(taskRoot, "instruction.md")
  const environmentRoot = path.join(taskRoot, "environment")
  const taskTomlPath = path.join(taskRoot, "task.toml")
  for (const required of [taskRoot, instructionPath, environmentRoot, taskTomlPath, path.join(taskRoot, "tests", "test.sh")]) {
    if (!(await pathExists(required))) {
      throw new Error(`SkillsBench task is missing required file or directory: ${required}`)
    }
  }

  const runRoot = path.join(input.cwd, "auto-evolve", "runtime-state", "skillsbench-runs", `${nowStamp()}-${safeID(input.taskID)}-${input.mode}`)
  const workDir = path.join(runRoot, "workspace")
  const logsDir = path.join(runRoot, "logs")
  const specDir = path.join(runRoot, "spec")
  await Promise.all([workDir, logsDir, specDir].map((dir) => ensureDirectory(dir)))
  await copyEnvironmentWithoutLeaks(environmentRoot, workDir)

  const instruction = await readTextFile(instructionPath)
  await writeTextFile(path.join(runRoot, "instruction.copy.md"), instruction)
  await writeJsonFile(path.join(runRoot, "task-source.json"), {
    taskID: input.taskID,
    taskRoot,
    sourceRoot: root,
    mode: input.mode,
    createdAt: new Date().toISOString(),
    note: "The workspace is copied from SkillsBench environment/ only. solution/, tests/, and groundtruth-style files are intentionally not exposed to the agent.",
  })

  return {
    taskID: input.taskID,
    taskRoot,
    instructionPath,
    workDir,
    logsDir,
    specDir,
    runRoot,
    imageTag: dockerImageTag(input.taskID),
    instruction,
  }
}

async function runProcessLogged(input: {
  title: string
  command: string[]
  cwd: string
  timeoutMs: number
  logsDir: string
  prefix: string
  env?: NodeJS.ProcessEnv
}) {
  const result = await runManagedProcess({
    title: input.title,
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    env: input.env,
  })
  await writeTextFile(path.join(input.logsDir, `${input.prefix}.command.txt`), input.command.join("\n"))
  await writeTextFile(path.join(input.logsDir, `${input.prefix}.stdout.log`), result.stdout)
  await writeTextFile(path.join(input.logsDir, `${input.prefix}.stderr.log`), result.stderr)
  await writeJsonFile(path.join(input.logsDir, `${input.prefix}.result.json`), result)
  return result
}

async function readReward(logsDir: string) {
  const rewardPath = path.join(logsDir, "verifier", "reward.txt")
  if (!(await pathExists(rewardPath))) return undefined
  return (await readTextFile(rewardPath)).trim()
}

function looksLikeVerifierInfrastructureFailure(text: string) {
  const haystack = text.toLowerCase()
  return [
    "temporary failure resolving",
    "could not resolve",
    "connection timed out",
    "network is unreachable",
    "failed to fetch",
    "archive.ubuntu.com",
    "security.ubuntu.com",
    "apt-get",
    "unable to locate package",
    "curl: (28)",
    "curl: (6)",
    "uv installer",
  ].some((needle) => haystack.includes(needle))
}

async function summarizeVerifierLogs(logsDir: string, run: ManagedProcessResult) {
  const reward = await readReward(logsDir)
  const combinedOutput = `${run.stderr}\n${run.stdout}`
  const infrastructureFailure =
    reward !== "1" && (run.timedOut || reward === undefined) && looksLikeVerifierInfrastructureFailure(combinedOutput)
  const details = [
    `reward.txt=${reward ?? "missing"}`,
    `docker exitCode=${run.exitCode}`,
    infrastructureFailure ? "failureKind=verifier_infrastructure" : "",
    run.timedOut ? "docker verifier timed out" : "",
    run.stderr.trim() ? `stderr: ${run.stderr.trim().slice(0, 800)}` : "",
    run.stdout.trim() ? `stdout: ${run.stdout.trim().slice(0, 1200)}` : "",
  ].filter(Boolean)
  const passed = reward === "1"
  return {
    passed,
    failureKind: passed ? undefined : infrastructureFailure ? ("verifier_infrastructure" as const) : ("task_failure" as const),
    summary: passed
      ? "SkillsBench official verifier passed."
      : infrastructureFailure
        ? "SkillsBench official verifier infrastructure failed before judging the answer."
        : "SkillsBench official verifier failed.",
    details,
  }
}

export async function runSkillsBenchVerifier(input: {
  taskRoot: string
  workDir: string
  logsDir: string
  imageTag?: string
  timeoutMs?: number
  skipDockerBuild?: boolean
}): Promise<SkillsBenchVerifierResult> {
  const taskRoot = path.resolve(input.taskRoot)
  const workDir = path.resolve(input.workDir)
  const logsDir = path.resolve(input.logsDir)
  const environmentRoot = path.join(taskRoot, "environment")
  const dockerfilePath = path.join(environmentRoot, "Dockerfile")
  const testsRoot = path.join(taskRoot, "tests")
  const imageTag = input.imageTag ?? dockerImageTag(path.basename(taskRoot))
  const timeoutMs = input.timeoutMs ?? 60 * 60 * 1000
  await ensureDirectory(logsDir)
  await ensureDirectory(path.join(logsDir, "verifier"))

  let build: ManagedProcessResult | undefined
  if (!input.skipDockerBuild) {
    build = await runProcessLogged({
      title: `SkillsBench docker build ${path.basename(taskRoot)}`,
      command: ["docker", "build", "-t", imageTag, "-f", dockerfilePath, environmentRoot],
      cwd: taskRoot,
      timeoutMs,
      logsDir,
      prefix: "docker-build",
      env: { PYTHONUTF8: "1" },
    })
    if (build.exitCode !== 0 || build.timedOut) {
      const run: ManagedProcessResult = {
        exitCode: build.exitCode,
        stdout: "",
        stderr: build.stderr,
        timedOut: build.timedOut,
        hardTimedOut: build.hardTimedOut,
        silentTimedOut: build.silentTimedOut,
        silentTimeoutAfterActivity: build.silentTimeoutAfterActivity,
        observedRuntimeOutput: build.observedRuntimeOutput,
      }
      return {
        passed: false,
        summary: "SkillsBench docker image build failed.",
        details: [build.stderr.trim() || build.stdout.trim() || "Docker build failed without detailed output."],
        logsDir,
        imageTag,
        failureKind: "docker_build_failure",
        build,
        run,
      }
    }
  }

  const verifyCommand = [
    "docker",
    "run",
    "--rm",
    "-v",
    `${workDir}:/root`,
    "-v",
    `${testsRoot}:/tests:ro`,
    "-v",
    `${logsDir}:/logs`,
    imageTag,
    "bash",
    "/tests/test.sh",
  ]
  let run = await runProcessLogged({
    title: `SkillsBench verifier ${path.basename(taskRoot)}`,
    command: verifyCommand,
    cwd: taskRoot,
    timeoutMs,
    logsDir,
    prefix: "docker-verify-attempt-01",
    env: { PYTHONUTF8: "1" },
  })
  let summary = await summarizeVerifierLogs(logsDir, run)
  if (!summary.passed) {
    // Docker Desktop on Windows can occasionally expose a just-written mounted
    // workspace late enough for the first verifier pass to report missing files.
    // Re-running the same official verifier once keeps the standard unchanged
    // while avoiding a false task failure from mount/readiness flakiness.
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const retry = await runProcessLogged({
      title: `SkillsBench verifier retry ${path.basename(taskRoot)}`,
      command: verifyCommand,
      cwd: taskRoot,
      timeoutMs,
      logsDir,
      prefix: "docker-verify-attempt-02",
      env: { PYTHONUTF8: "1" },
    })
    const retrySummary = await summarizeVerifierLogs(logsDir, retry)
    retrySummary.details.unshift(`retryAfterFirstVerifierResult=${summary.summary}`)
    run = retry
    summary = retrySummary
  }
  return {
    ...summary,
    logsDir,
    imageTag,
    build,
    run,
  }
}

function buildSkillsBenchShortPrompt(input: {
  prepared: PreparedSkillsBenchTask
  previousFailures: SkillsBenchVerifierResult[]
}) {
  const feedback = input.previousFailures.length
    ? [
        "Previous verifier feedback from earlier attempt(s):",
        ...input.previousFailures.map((item, index) => {
          return [`Attempt ${index + 1}: ${item.summary}`, ...item.details.slice(0, 8).map((line) => `- ${line}`)].join("\n")
        }),
      ].join("\n\n")
    : "No previous verifier feedback yet."

  return [
    "You are solving one SkillsBench task inside an auto-evolve short-task smoke run.",
    "",
    "Important path mapping:",
    `- The SkillsBench instruction may mention Linux paths such as /root/file.ext.`,
    `- In this Windows session, /root means this copied workspace directory: ${input.prepared.workDir}`,
    "- Create or update the requested output files directly inside that workspace.",
    "- You may read the task input files and reusable skills under the workspace.",
    "- The hidden solution and hidden verifier tests are not available to you; do not look for them.",
    "- Do not modify the original SkillsBench dataset directory.",
    "- Use headless file processing only.",
    "",
    "Task instruction:",
    input.prepared.instruction,
    "",
    feedback,
    "",
    "When finished, return a short JSON object with claim_statement, outputs, blockers, and self_checks.",
  ].join("\n")
}

async function runShortSkillsBenchTask(input: SkillsBenchRunOptions, prepared: PreparedSkillsBenchTask) {
  const config = await loadConfig(input.cwd)
  const taskToml = await readTextFile(path.join(prepared.taskRoot, "task.toml"))
  const verifierTimeoutMs = input.timeoutMs ?? parseTaskTimeoutMs(taskToml, "verifier", 60 * 60 * 1000)
  const attempts = Math.max(1, input.attempts ?? 2)
  const attemptResults: Array<{
    attempt: number
    opencode: OpencodeTaskRun
    verifier: SkillsBenchVerifierResult
  }> = []
  const verifierFailures: SkillsBenchVerifierResult[] = []

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const stageDir = path.join(prepared.runRoot, `short-attempt-${String(attempt).padStart(2, "0")}`)
    await ensureDirectory(stageDir)
    const prompt = buildSkillsBenchShortPrompt({ prepared, previousFailures: verifierFailures })
    const opencode = await runOpencodeTask({
      cwd: input.cwd,
      config,
      title: `SkillsBench Short ${prepared.taskID} attempt-${String(attempt).padStart(2, "0")}`,
      prompt,
      referencePaths: [prepared.instructionPath, prepared.workDir],
      promptInlineFiles: [prepared.instructionPath],
      permissionReadPaths: [prepared.instructionPath, prepared.workDir],
      permissionEditPaths: [prepared.workDir],
      runtimeScope: `skillsbench-short:${prepared.taskID}:${randomUUID().slice(0, 8)}`,
      isolateHostRuntime: false,
      injectPlatformSafetyRules: true,
      live: {
        stageDir,
        taskKind: "skillsbench_short",
        phase: "skillsbench_short",
        caseID: prepared.taskID,
        attempt,
      },
    })
    await writeJsonFile(path.join(stageDir, "opencode-result.json"), {
      title: opencode.title,
      sessionID: opencode.result.sessionID,
      exitCode: opencode.result.exitCode,
      responseText: opencode.result.responseText,
      toolFailureCount: opencode.result.toolFailures.length,
      referencedPaths: opencode.referencedPaths,
      permissionEditPaths: opencode.permissionEditPaths,
    })

    const verifier = await runSkillsBenchVerifier({
      taskRoot: prepared.taskRoot,
      workDir: prepared.workDir,
      logsDir: path.join(stageDir, "verifier"),
      imageTag: prepared.imageTag,
      timeoutMs: verifierTimeoutMs,
      skipDockerBuild: input.skipDockerBuild === true || attempt > 1,
    })
    attemptResults.push({ attempt, opencode, verifier })
    if (verifier.passed) break
    verifierFailures.push(verifier)
  }

  const final = attemptResults.at(-1)?.verifier
  await writeJsonFile(path.join(prepared.runRoot, "result.json"), {
    mode: "short",
    taskID: prepared.taskID,
    passed: final?.passed ?? false,
    attempts: attemptResults.map((item) => ({
      attempt: item.attempt,
      sessionID: item.opencode.result.sessionID,
      opencodeExitCode: item.opencode.result.exitCode,
      toolFailureCount: item.opencode.result.toolFailures.length,
      verifierPassed: item.verifier.passed,
      verifierSummary: item.verifier.summary,
      verifierFailureKind: item.verifier.failureKind ?? null,
      verifierDetails: item.verifier.details,
      verifierLogsDir: item.verifier.logsDir,
    })),
    runRoot: prepared.runRoot,
    workDir: prepared.workDir,
  })
  return {
    mode: "short" as const,
    taskID: prepared.taskID,
    passed: final?.passed ?? false,
    runRoot: prepared.runRoot,
    workDir: prepared.workDir,
    attempts: attemptResults.length,
    verifier: final,
  }
}

async function runLongSkillsBenchTask(input: SkillsBenchRunOptions, prepared: PreparedSkillsBenchTask) {
  const taskToml = await readTextFile(path.join(prepared.taskRoot, "task.toml"))
  const verifierTimeoutMs = input.timeoutMs ?? parseTaskTimeoutMs(taskToml, "verifier", 60 * 60 * 1000)
  const verifierScript = path.join(input.cwd, "auto-evolve", "scripts", "skillsbench-verify.ts")
  const specPath = path.join(prepared.specDir, "long-task-spec.json")
  const promptGuidePath = path.join(prepared.specDir, "skillsbench-path-guide.md")
  await writeTextFile(
    promptGuidePath,
    [
      "# SkillsBench path guide",
      "",
      `The task instruction may mention /root. In this host run, /root maps to: ${prepared.workDir}`,
      "Write all requested output files into that copied workspace.",
      "Do not read or modify solution/ or tests/. They are hidden and not part of the editable workspace.",
      "The official SkillsBench verifier will run later in Docker against the copied workspace.",
    ].join("\n") + "\n",
  )
  await writeJsonFile(specPath, {
    id: `skillsbench-${safeID(prepared.taskID)}`,
    title: `SkillsBench ${prepared.taskID}`,
    goal: [
      `Solve the SkillsBench task ${prepared.taskID}.`,
      `The instruction uses /root paths; for this host session /root maps to ${prepared.workDir}.`,
      "Create the requested output files in the copied workspace and make the official SkillsBench verifier pass.",
    ].join(" "),
    taskFamily: "skillsbench",
    domainTags: ["skillsbench", "external-verifier"],
    materials: [
      { path: prepared.instructionPath, label: "SkillsBench instruction", role: "task-instruction" },
      { path: prepared.workDir, label: "copied task workspace", role: "working-directory" },
    ],
    targetPaths: [{ path: prepared.workDir, label: "SkillsBench output workspace", role: "output-workspace" }],
    editablePaths: [prepared.workDir],
    preservePreseededEditablePaths: [prepared.workDir],
    initialExpertContextPaths: [promptGuidePath, prepared.instructionPath],
    validators: [
      {
        id: "skillsbench-official-verifier",
        type: "script",
        title: "SkillsBench official verifier",
        path: verifierScript,
        runner: "bun",
        placement: "completion_only",
        required: true,
        blocking: true,
        inputMode: "none",
        timeoutMs: verifierTimeoutMs,
        args: [
          "--task-root",
          prepared.taskRoot,
          "--work-dir",
          prepared.workDir,
          "--logs-dir",
          path.join(prepared.runRoot, "long-verifier"),
          "--image-tag",
          prepared.imageTag,
          ...(input.skipDockerBuild === true ? ["--skip-docker-build"] : []),
        ],
      },
    ],
    execution: {
      agent: "build",
    },
    planning: {
      agent: "build",
    },
    validation: {
      agent: "build",
    },
    initialGraph: {
      planner_summary: "Single-workspace SkillsBench smoke run: inspect the instruction and workspace, create outputs, then rely on the official verifier.",
      completion_validator_ids: ["skillsbench-official-verifier"],
      units: [
        {
          id: "solve-skillsbench-task",
          title: "Solve SkillsBench Task",
          goal: [
            `Read the SkillsBench instruction for ${prepared.taskID}.`,
            `Use ${prepared.workDir} as the mapped /root workspace.`,
            "Create the requested output files and prepare for official verifier acceptance.",
          ].join(" "),
          inputs: [prepared.instructionPath, prepared.workDir, promptGuidePath],
          depends_on: [],
          expected_artifacts: [prepared.workDir],
          claim: "The SkillsBench task output files are produced in the copied workspace.",
          check_plan: "Self-check that requested files exist, then allow the official SkillsBench verifier to decide final pass/fail.",
          validator_ids: [],
          retry_budget: Math.max(1, input.attempts ?? 2),
        },
      ],
    },
    budgets: {
      maxAttemptsPerUnit: Math.max(1, input.attempts ?? 2),
      maxTotalUnitAttempts: Math.max(2, input.attempts ?? 2),
      maxGraphReplans: 1,
      maxValidatorCalls: 4,
      maxNoProgressCycles: 3,
      maxUnitsPerGraph: 3,
    },
    notes: "Generated by the auto-evolve SkillsBench adapter.",
  })

  const result = await runLongTask({ cwd: input.cwd, specPath })
  const summary = await readJsonFile<{
    verificationSignal?: { completionGatePassed?: boolean }
    roundClosure?: string
  }>(result.summaryPath).catch(() => undefined)
  const passed =
    result.status === "verified_success" ||
    summary?.verificationSignal?.completionGatePassed === true ||
    summary?.roundClosure === "closed_success"
  await writeJsonFile(path.join(prepared.runRoot, "result.json"), {
    mode: "long",
    taskID: prepared.taskID,
    passed,
    status: result.status,
    completionGatePassed: summary?.verificationSignal?.completionGatePassed ?? null,
    roundClosure: summary?.roundClosure ?? null,
    summaryPath: result.summaryPath,
    runDir: result.runDir,
    specPath,
    workDir: prepared.workDir,
  })
  return {
    mode: "long" as const,
    taskID: prepared.taskID,
    passed,
    status: result.status,
    runRoot: prepared.runRoot,
    workDir: prepared.workDir,
    runDir: result.runDir,
    summaryPath: result.summaryPath,
  }
}

export async function runSkillsBenchTask(input: SkillsBenchRunOptions) {
  const prepared = await prepareSkillsBenchTask(input)
  if (input.mode === "short") return runShortSkillsBenchTask(input, prepared)
  return runLongSkillsBenchTask(input, prepared)
}
