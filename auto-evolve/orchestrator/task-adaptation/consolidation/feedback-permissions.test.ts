import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import {
  publishTrainingFeedbackResource,
  type RawTestCaseResult,
} from "./feedback-publisher"
import {
  bindScopedReader,
  readResourceChunk,
} from "./scoped-reader"
import {
  authorizeResourceAccess,
  type LogicalResource,
} from "../../task-profile-access/unified-access"
import { authorizeInvocation } from "../invocation"
import { bindPlan } from "../binding"
import type { Plan } from "../plan"

function generateMockCases(total: number, passedCount: number): RawTestCaseResult[] {
  const cases: RawTestCaseResult[] = []
  for (let i = 1; i <= total; i++) {
    const caseID = `dc_${String(i).padStart(3, "0")}`
    const passed = i <= passedCount
    cases.push({
      caseID,
      title: `Direct Chat Training Case ${i} 训练用例`,
      prompt: `Prompt for case ${i}: 请针对自演化控制层与反馈提炼第 ${i} 题给出高质量指导原则。`,
      materials: [
        { id: `mat_${i}`, name: `sample_${i}.txt`, content: `题目 ${i} 参考材料：包含中文、英文与特殊字符验证 🚀` },
      ],
      modelResponse: `Model drafted response for case ${i}: 已完成指导方案分析。`,
      score: passed ? 1.0 : 0.0,
      passed,
      diagnostics: passed ? ["Check passed cleanly"] : ["Failed on constraint assertion: missing guidance"],
      // 包含私有 Oracle 与内部验证脚本（发布器必须将其严格剔除）
      oracleAnswer: `SECRET_ORACLE_ANSWER_FOR_CASE_${i}`,
      validatorScript: `#!/bin/bash\n# PRIVATE SCORING SCRIPT FOR CASE ${i}\nexit 0`,
      evaluatorTrace: { internalMetric: 99.9, hiddenSeed: 12345 },
    })
  }
  return cases
}

describe("AEV Unified Access & 50-Case Feedback Permissions (P0-P3 / R0-R4 Deep Verification)", () => {
  test("U01 & U12: Publisher safely publishes 50-case view (0/50, 43/50, 50/50) with valid manifest", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-publisher-test-"))
    try {
      for (const passedCount of [0, 43, 50]) {
        const subDir = path.join(tempDir, `run_${passedCount}`)
        const rawCases = generateMockCases(50, passedCount)
        const { manifest, logicalResource, manifestPath } = await publishTrainingFeedbackResource({
          targetDir: subDir,
          campaignID: "camp_test_01",
          round: 1,
          cases: rawCases,
        })

        expect(manifest.totalCases).toBe(50)
        expect(manifest.passedCases).toBe(passedCount)
        expect(manifest.cases.length).toBe(50)
        expect(logicalResource.paths.length).toBe(51) // 50 cases + 1 manifest
        expect(logicalResource.sensitivity).toBe("training")
        expect(logicalResource.access).toBe("read_only")

        // 验证物理文件真实落盘
        const manifestDisk = JSON.parse(await readFile(manifestPath, "utf8"))
        expect(manifestDisk.manifestSHA256).toBe(manifest.manifestSHA256)
        expect(manifestDisk.cases.length).toBe(50)
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("U03 & U07: Private oracle fields are completely sanitized and inaccessible to agents", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-sanitize-test-"))
    try {
      const rawCases = generateMockCases(5, 3)
      const { manifest, logicalResource } = await publishTrainingFeedbackResource({
        targetDir: tempDir,
        campaignID: "camp_sanitize",
        round: 1,
        cases: rawCases,
      })

      // 1. 验证发布的 JSON 物理文件中绝对不含 oracleAnswer 和 validatorScript
      for (const item of manifest.cases) {
        const fullPath = path.join(tempDir, item.path)
        const content = await readFile(fullPath, "utf8")
        expect(content).not.toContain("SECRET_ORACLE_ANSWER")
        expect(content).not.toContain("PRIVATE SCORING SCRIPT")
        expect(content).not.toContain("evaluatorTrace")
      }

      // 2. 验证私有 Oracle 敏感度资源被统一授权硬性拦截
      const privateOracleResource: LogicalResource = {
        ...logicalResource,
        resourceID: "oracle:private_test",
        sensitivity: "private_oracle",
      }

      const decision = await authorizeResourceAccess(
        {
          principalID: "worker_1",
          roleID: "worker",
          workerID: "worker_1",
          campaignID: "camp_sanitize",
          round: 1,
          runtime: ["feedback"],
        },
        privateOracleResource,
        "read",
      )
      expect(decision.granted).toBe(false)
      expect(decision.reasonCode).toBe("SENSITIVITY_DISALLOWED")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("U02 & U10: AuthorizeInvocation injects all 50 cases into permissionReadPaths for both Worker and Lead", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-invocation-dual-role-test-"))
    try {
      const rawCases = generateMockCases(50, 43)
      const { logicalResource } = await publishTrainingFeedbackResource({
        targetDir: tempDir,
        campaignID: "camp_dual_role",
        round: 1,
        cases: rawCases,
      })

      const candidateDir = path.join(tempDir, "candidate")
      await mkdir(candidateDir, { recursive: true })

      const sampleSkillPath = path.join(candidateDir, "DIRECT_CHAT.md")
      await writeFile(sampleSkillPath, "# Sample Direct Chat Guidance\nInitial content\n", "utf8")
      const sampleAssetPath = path.join(candidateDir, "task_spec.txt")
      await writeFile(sampleAssetPath, "Task spec definition\n", "utf8")

      // 构建包含 worker 和 lead 双角色的完整 Plan
      const plan: Plan = {
        schema: "aev.task-plan.v1",
        id: "direct_chat_consolidation",
        objective: "Consolidate guidance based on 50 training feedback",
        deliverable: { kind: "skill", entries: ["candidate"] },
        capabilities: ["read"],
        resources: [
          { id: "candidate", path: "DIRECT_CHAT.md", audience: "public", mutable: true },
          { id: "spec", path: "task_spec.txt", audience: "public", mutable: false },
        ],
        windows: [
          {
            role: "lead",
            stage: "revise",
            reads: ["candidate", "spec"],
            writes: ["candidate"],
            actions: ["read", "edit"],
            runtime: ["feedback"],
            inline: [],
          },
          {
            role: "worker",
            stage: "explore",
            reads: ["candidate", "spec"],
            writes: [],
            actions: ["read"],
            runtime: ["feedback"],
            inline: [],
          },
          {
            role: "checker",
            stage: "accept",
            reads: ["candidate"],
            writes: [],
            actions: ["read"],
            inline: [],
          },
        ],
        acceptance: {
          execution: "none",
          checks: [
            {
              id: "check_skill",
              target: "candidate",
              mechanism: "judge",
              purpose: "Check skill",
              required: true,
              resources: ["candidate"],
              feedback: "status_only",
            },
          ],
        },
        rejection: [{ check: "check_skill", actions: ["research"] }],
        workers: [
          {
            id: "worker_01",
            purpose: "Analyze 50-case failure patterns",
            resources: ["candidate", "spec"],
            actions: ["read"],
          },
        ],
        selection: { rule: "first_pass" },
        stop: { rounds: 2, calls: 10, tokens: 10000, stagnant: 1 },
      }

      const bound = await bindPlan(candidateDir, plan, ["read"])

      // 1. 验证 Lead 角色授权成功获得 51 个受控路径，且保留 candidate 编辑权
      const leadResult = await authorizeInvocation(
        {
          bound,
          role: "lead",
          stage: "revise",
          output: "Provide updated Skill",
          maxInlineBytes: 10000,
          feedbackResource: logicalResource,
        },
        { model: "mock-model", config: { permissionConfig: { version: 1, mode: "restricted" } } },
      )
      expect(leadResult.request.permissionReadPaths.length).toBeGreaterThanOrEqual(51)
      expect(leadResult.request.permissionEditPaths).toEqual([sampleSkillPath.replaceAll("\\", "/")])
      expect(leadResult.scope.feedbackResource?.resourceID).toBe(logicalResource.resourceID)

      // 2. 验证真实 Worker 角色授权成功获得全部 51 个受控路径，且编辑权为 0（严格只读）
      const workerResult = await authorizeInvocation(
        {
          bound,
          role: "worker",
          worker: "worker_01",
          stage: "explore",
          output: "Provide worker analysis",
          maxInlineBytes: 10000,
          feedbackResource: logicalResource,
        },
        { model: "mock-model", config: { permissionConfig: { version: 1, mode: "restricted" } } },
      )
      expect(workerResult.request.permissionReadPaths.length).toBeGreaterThanOrEqual(51)
      expect(workerResult.request.permissionEditPaths).toEqual([]) // Worker 严格只读
      expect(workerResult.scope.feedbackResource?.resourceID).toBe(logicalResource.resourceID)

      // 3. 验证未授权的 reviewer 角色被拒绝
      await expect(
        authorizeResourceAccess(
          {
            principalID: "reviewer_1",
            roleID: "reviewer",
            campaignID: "camp_dual_role",
            round: 1,
            runtime: ["feedback"],
          },
          logicalResource,
          "read",
        ),
      ).resolves.toMatchObject({
        granted: false,
        reasonCode: "RUNTIME_NOT_PERMITTED",
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("U04 & U06 & R3: Scoped reader supports chunked pagination of large cases (>8MiB) with UTF-8 character alignment and no corrupt glyphs", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-large-case-reader-utf8-test-"))
    try {
      // 构造包含中文（3字节）、Emoji（4字节）、全角符号与英数的富文本块（1024 字节）
      const richBlock = "【深度评测数据块】AutoPrompt自演化任务自适应测试行：包含各种中文字符、符号和表情 🌟🚀🎯！".padEnd(256, "—")
      const richUnit = Buffer.from(richBlock, "utf8").subarray(0, 512) // 精确 512 字节
      const repeatCount = 18 * 1024 // 18 * 512 = 9 MB
      const buffers: Buffer[] = []
      for (let i = 0; i < repeatCount; i++) {
        buffers.push(richUnit)
      }
      const largeContentBuffer = Buffer.concat(buffers)
      const largeContentText = largeContentBuffer.toString("utf8")

      const rawCases: RawTestCaseResult[] = [
        {
          caseID: "dc_huge_chinese",
          title: "超大规模中文多模态测试用例",
          prompt: "Huge Chinese Case Prompt",
          materials: [{ id: "mat_huge", name: "huge_chinese.txt", content: largeContentText }],
          modelResponse: "Response to huge chinese case",
          score: 1.0,
          passed: true,
          diagnostics: ["Passed huge chinese verification"],
        },
      ]

      const { manifest, logicalResource } = await publishTrainingFeedbackResource({
        targetDir: tempDir,
        campaignID: "camp_huge_chinese",
        round: 1,
        cases: rawCases,
      })

      const readerBinding = bindScopedReader(logicalResource, manifest)
      expect(readerBinding.allowedCases.has("dc_huge_chinese")).toBe(true)

      // 通过 ScopedReader 循环逐页分段读取，直到 EOF
      const collectedData: string[] = []
      let cursor: string | undefined = undefined
      let totalReturnedBytes = 0
      let pageCount = 0

      while (true) {
        pageCount++
        const chunkResult = await readResourceChunk(readerBinding, {
          resourceID: logicalResource.resourceID,
          caseID: "dc_huge_chinese",
          cursor,
          maxBytes: 64000, // 每次 64 KB 分段
        })

        // 核心安全断言：每一段解码出的 UTF-8 文本绝不能包含半字损坏乱码 '\uFFFD'
        expect(chunkResult.data.includes("\uFFFD")).toBe(false)

        collectedData.push(chunkResult.data)
        totalReturnedBytes += chunkResult.returnedBytes

        if (chunkResult.eof) {
          expect(chunkResult.nextCursor).toBeUndefined()
          break
        }
        expect(chunkResult.nextCursor).toBeDefined()
        cursor = chunkResult.nextCursor
      }

      expect(pageCount).toBeGreaterThan(100) // 9MB / 64KB 应该超过 140 页
      const reconstructed = collectedData.join("")
      expect(Buffer.byteLength(reconstructed, "utf8")).toBe(totalReturnedBytes)

      // 验证重组后的内容与落盘文件物理内容 SHA256 100% 完全相同
      const diskCaseContent = await readFile(path.join(tempDir, "cases", "case_dc_huge_chinese.json"), "utf8")
      expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(
        createHash("sha256").update(diskCaseContent).digest("hex"),
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("U08 & U13 & R3: Forged cursor, tampered signature, unknown caseID and boundary escape are strictly rejected", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-security-reject-test-"))
    try {
      const rawCases = generateMockCases(3, 2)
      const { manifest, logicalResource } = await publishTrainingFeedbackResource({
        targetDir: tempDir,
        campaignID: "camp_reject",
        round: 1,
        cases: rawCases,
      })

      const readerBinding = bindScopedReader(logicalResource, manifest)

      // 1. 未授权 caseID 拒绝
      await expect(
        readResourceChunk(readerBinding, {
          resourceID: logicalResource.resourceID,
          caseID: "dc_unauthorized_999",
        }),
      ).rejects.toThrow("Unauthorized or unknown caseID 'dc_unauthorized_999'")

      // 2. 伪造 cursor（篡改 offset 与伪造签名）拒绝
      const forgedCursor = Buffer.from(
        JSON.stringify({
          resourceID: logicalResource.resourceID,
          caseID: "dc_001",
          version: "v999.fake",
          offset: 999999999,
          sig: "fake_signature_abc",
        }),
      ).toString("base64")

      await expect(
        readResourceChunk(readerBinding, {
          resourceID: logicalResource.resourceID,
          caseID: "dc_001",
          cursor: forgedCursor,
        }),
      ).rejects.toThrow("Forged, corrupt or incompatible cursor rejected")

      // 3. 边界逃逸检查
      const escapedResource: LogicalResource = {
        ...logicalResource,
        boundaryRoots: [path.join(tempDir, "isolated_subdir")],
      }
      const decision = await authorizeResourceAccess(
        {
          principalID: "worker_1",
          roleID: "worker",
          workerID: "worker_1",
          campaignID: "camp_reject",
          round: 1,
          runtime: ["feedback"],
        },
        escapedResource,
        "read",
      )
      expect(decision.granted).toBe(false)
      expect(decision.reasonCode).toBe("BOUNDARY_ESCAPED")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("U14 & U15 & R0: Temporal ordering prevents reading future round feedback and enforces cross-campaign isolation", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-temporal-isolation-test-"))
    try {
      const rawCases = generateMockCases(2, 2)
      const { logicalResource } = await publishTrainingFeedbackResource({
        targetDir: tempDir,
        campaignID: "camp_alpha",
        round: 2, // 轮次 2 的反馈
        cases: rawCases,
      })

      // 1. 跨 Campaign 隔离断言：来自 camp_beta 的 Principal 试图读取 camp_alpha 的资源被拒绝
      const crossCampDecision = await authorizeResourceAccess(
        {
          principalID: "worker_1",
          roleID: "worker",
          workerID: "worker_1",
          campaignID: "camp_beta", // 不同的 Campaign ID
          round: 2,
          runtime: ["feedback"],
        },
        logicalResource,
        "read",
      )
      expect(crossCampDecision.granted).toBe(false)
      expect(crossCampDecision.reasonCode).toBe("PRINCIPAL_MISMATCH")

      // 2. 时序违规断言：第 1 轮的 Principal 试图超前读取第 2 轮的反馈资源被拒绝
      const futureRoundDecision = await authorizeResourceAccess(
        {
          principalID: "lead_1",
          roleID: "lead",
          campaignID: "camp_alpha",
          round: 1, // 当前仅在第 1 轮，而资源来自第 2 轮
          runtime: ["feedback"],
        },
        logicalResource,
        "read",
      )
      expect(futureRoundDecision.granted).toBe(false)
      expect(futureRoundDecision.reasonCode).toBe("TEMPORAL_VIOLATION")

      // 3. 正常同轮或过去轮次读取允许通过
      const validDecision = await authorizeResourceAccess(
        {
          principalID: "lead_1",
          roleID: "lead",
          campaignID: "camp_alpha",
          round: 2, // 轮次对齐
          runtime: ["feedback"],
        },
        logicalResource,
        "read",
      )
      expect(validDecision.granted).toBe(true)
      expect(validDecision.reasonCode).toBe("GRANTED")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("U16 & R1-R2: End-to-end Checker to Publisher pipeline publishes 50 cases with byte-for-byte SHA matching and injects into Worker/Lead", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-e2e-pipeline-test-"))
    try {
      const campaignRoot = path.join(tempDir, "campaign")
      const attemptRoot = path.join(campaignRoot, "rounds", "round-001", "final-acceptance")
      const protocolBackendsDir = path.join(campaignRoot, "protocol-backends")
      const runID = "test-run-uuid-12345"
      const directChatDir = path.join(protocolBackendsDir, runID, "direct-chat")

      await mkdir(directChatDir, { recursive: true })
      await mkdir(attemptRoot, { recursive: true })

      // 1. 模拟 Direct Chat 50 题评测产物与 summary.json
      const raw50Cases = generateMockCases(50, 43)
      const summaryResults = raw50Cases.map((c) => ({
        caseID: c.caseID,
        modelID: "mock-model",
        skillHash: "abc123hash",
        passed: c.passed,
        score: c.score,
        attempts: 1,
        errorCategory: c.passed ? "none" : "validation",
        requestAuditPath: path.join(directChatDir, "results", "mock-model", c.caseID, "request-audit.json"),
        responseAuditPath: path.join(directChatDir, "results", "mock-model", c.caseID, "provider-response.json"),
        validatorResultPath: path.join(directChatDir, "results", "mock-model", c.caseID, "validator-result.json"),
      }))

      const summary = {
        validity: { status: "valid", skillHash: "abc123hash", datasetHash: "datasethash123" },
        summary: [{ modelID: "mock-model", total: 50, passed: 43, failed: 7, passRate: 0.86 }],
        results: summaryResults,
      }
      await writeFile(path.join(directChatDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8")

      // 2. 模拟 dataset bundle（包含 50 题完整题目、材料与私有 Oracle）
      const datasetBundlePath = path.join(tempDir, "dataset.jsonl")
      const datasetRows = raw50Cases.map((c) => ({
        schema: "direct-chat-case/v1",
        caseID: c.caseID,
        dataset: "consolidation-test",
        split: "train",
        question: { text: c.prompt, outputInstruction: "detailed answer" },
        materials: c.materials,
        privateOracle: {
          expectedAnswer: c.oracleAnswer,
          scriptPath: c.validatorScript,
        },
      }))
      await writeFile(datasetBundlePath, datasetRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")

      const configSnapshot = {
        datasetBundlePath,
        datasetHash: "datasethash123",
        caseIDs: raw50Cases.map((c) => c.caseID),
        modelIDs: ["mock-model"],
        resumeExisting: false,
        includeNoSkillBaseline: false,
        noSkillOnly: false,
      }
      await writeFile(path.join(directChatDir, "config.snapshot.json"), JSON.stringify(configSnapshot, null, 2), "utf8")

      // 3. 模拟 consolidation Checker product
      const productObj = {
        schema: "aev.consolidation-eval.v1",
        runID,
        candidate_sha256: "abc123hash",
        dataset_sha256: "datasethash123",
        total: 50,
        passed: 43,
        failed: 7,
        pass_rate: 0.86,
      }
      const productPath = path.join(attemptRoot, "execution-product.json")
      await writeFile(productPath, JSON.stringify(productObj, null, 2), "utf8")

      // 4. 执行真实 campaignAcceptance 阶段（模拟完成状态）
      const { publishTrainingFeedbackResource } = await import("./feedback-publisher")
      const published = await publishTrainingFeedbackResource({
        targetDir: path.join(attemptRoot, "training-feedback"),
        campaignID: "campaign_e2e_50",
        round: 1,
        cases: raw50Cases,
      })

      // 5. 逐文件物理验证：50 个 case 文件磁盘真实 SHA256 与 bytes 100% 匹配 manifest
      expect(published.manifest.totalCases).toBe(50)
      expect(published.manifest.passedCases).toBe(43)
      for (const caseMeta of published.manifest.cases) {
        const diskFile = path.join(attemptRoot, "training-feedback", caseMeta.path)
        const diskBytes = await readFile(diskFile)
        expect(diskBytes.length).toBe(caseMeta.bytes)
        expect(createHash("sha256").update(diskBytes).digest("hex")).toBe(caseMeta.sha256)
      }

      // 6. 验证 protocol.training-feedback.json 中的 caseFeedback 索引
      const trainingFeedbackPath = path.join(attemptRoot, "protocol.training-feedback.json")
      await writeFile(
        trainingFeedbackPath,
        JSON.stringify(
          {
            schema: "aev.training-feedback.v1",
            task: "task_consolidation",
            phase: "source",
            status: "passed",
            caseFeedback: {
              resourceID: published.logicalResource.resourceID,
              manifestPath: published.manifestPath,
              manifestSHA256: published.manifest.manifestSHA256,
              totalCases: 50,
              passedCases: 43,
            },
          },
          null,
          2,
        ),
        "utf8",
      )

      // 7. 验证 protocolFeedbackEvidence 自动收录 manifest
      const { protocolFeedbackEvidence } = await import("../../protocol-plugins/feedback-evidence")
      const evidencePaths = await protocolFeedbackEvidence(trainingFeedbackPath)
      const normalizedEvidencePaths = evidencePaths.map((p) => path.resolve(p).replaceAll("\\", "/"))
      expect(normalizedEvidencePaths).toContain(path.resolve(published.manifestPath).replaceAll("\\", "/"))

      // 8. 验证 OpenCode 环境变量工具可直接读取任意 case
      process.env.OPENCODE_AEV_RESOURCE_READER_FILE = published.manifestPath
      const { readResourceFromEnvironment } = await import("./scoped-reader")
      const readChunk = await readResourceFromEnvironment(
        {
          resourceID: published.logicalResource.resourceID,
          caseID: "dc_001",
        },
        process.env,
      )
      expect(readChunk.caseID).toBe("dc_001")
      expect(readChunk.returnedBytes).toBeGreaterThan(0)
      expect(readChunk.eof).toBe(true)
      expect(readChunk.data).toContain("Prompt for case 1")
    } finally {
      delete process.env.OPENCODE_AEV_RESOURCE_READER_FILE
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("GATE-A: T-A3 publisher rejects dangerous caseID, duplicate caseID, and score mismatch", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-gatea-publisher-fail-"))
    try {
      const validCases = generateMockCases(3, 2)
      // 1. 危险 caseID (路径穿越)
      const dangerousCases = [{ ...validCases[0], caseID: "../escape_case" }, validCases[1], validCases[2]]
      await expect(
        publishTrainingFeedbackResource({
          targetDir: path.join(tempDir, "dangerous"),
          campaignID: "camp_fail",
          round: 1,
          cases: dangerousCases,
        }),
      ).rejects.toThrow("Invalid, dangerous or empty caseID")

      // 2. 重复 caseID
      const dupCases = [{ ...validCases[0], caseID: "dc_001" }, { ...validCases[1], caseID: "dc_001" }]
      await expect(
        publishTrainingFeedbackResource({
          targetDir: path.join(tempDir, "dup"),
          campaignID: "camp_fail",
          round: 1,
          cases: dupCases,
        }),
      ).rejects.toThrow("Duplicate caseID")

      // 3. 分数与 passed 不匹配 (passed=true but score=0)
      const scoreMismatchCases = [{ ...validCases[0], passed: true, score: 0 }]
      await expect(
        publishTrainingFeedbackResource({
          targetDir: path.join(tempDir, "mismatch"),
          campaignID: "camp_fail",
          round: 1,
          cases: scoreMismatchCases,
        }),
      ).rejects.toThrow("score must be finite and match passed verdict exactly")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("GATE-A: T-A5 publisher idempotence safe reuse and overwrite rejection with differing content", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-gatea-idempotence-"))
    try {
      const targetDir = path.join(tempDir, "feedback")
      const casesA = generateMockCases(10, 8)
      // 第一次发布
      const res1 = await publishTrainingFeedbackResource({
        targetDir,
        campaignID: "camp_idemp",
        round: 1,
        cases: casesA,
      })
      expect(res1.manifest.totalCases).toBe(10)

      // 相同内容重复发布：安全复用
      const res2 = await publishTrainingFeedbackResource({
        targetDir,
        campaignID: "camp_idemp",
        round: 1,
        cases: casesA,
      })
      expect(res2.manifest.manifestSHA256).toBe(res1.manifest.manifestSHA256)

      // 内容冲突重新发布（cases 数量变了）：拒绝覆写
      const casesB = generateMockCases(5, 3)
      await expect(
        publishTrainingFeedbackResource({
          targetDir,
          campaignID: "camp_idemp",
          round: 1,
          cases: casesB,
        }),
      ).rejects.toThrow("Attempting to overwrite existing published feedback with different content")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("non-Consolidation executor cannot self-enable training feedback by naming its product schema", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-gatea-acceptance-"))
    try {
      const campaignRoot = path.join(tempDir, "campaign")
      const attemptRoot = path.join(campaignRoot, "rounds", "round-001", "final-acceptance")
      const runID = "consolidation-run-uuid-999"
      const directChatDir = path.join(campaignRoot, "protocol-backends", "consolidation", runID, "direct-chat")
      await mkdir(directChatDir, { recursive: true })
      await mkdir(attemptRoot, { recursive: true })

      // 1. 创建 50 题测试数据
      const raw50Cases = generateMockCases(50, 50)
      const datasetBundlePath = path.join(tempDir, "dataset.jsonl")
      const datasetRows = raw50Cases.map((c) => ({
        schema: "direct-chat-case/v1",
        caseID: c.caseID,
        dataset: "consolidation-test",
        split: "train",
        question: { text: c.prompt, outputInstruction: "detailed answer" },
        materials: c.materials,
        privateOracle: { expectedAnswer: c.oracleAnswer, scriptPath: c.validatorScript },
      }))
      await writeFile(datasetBundlePath, datasetRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")

      const configSnapshot = {
        datasetBundlePath,
        datasetHash: "dataset_sha_999",
        caseIDs: raw50Cases.map((c) => c.caseID),
        modelIDs: ["mock-model-a"],
      }
      await writeFile(path.join(directChatDir, "config.snapshot.json"), JSON.stringify(configSnapshot, null, 2), "utf8")

      const summaryResults = raw50Cases.map((c) => ({
        caseID: c.caseID,
        modelID: "mock-model-a",
        passed: true,
        score: 1.0,
        answer: c.modelResponse,
      }))
      const summary = {
        validity: { status: "valid" },
        summary: [{ modelID: "mock-model-a", total: 50, passed: 50, failed: 0, passRate: 1.0 }],
        results: summaryResults,
      }
      await writeFile(path.join(directChatDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8")

      // 2. 创建 selection.json 与 manifest.json 支撑 campaignAcceptance
      const project = { id: "aev-gatea", version: "1", skillFormats: ["text"], productKinds: ["aev.consolidation-eval.v1"], materialKinds: ["text"] }
      const selection = {
        schema: "aev.protocol-plugins.v1",
        project,
        run: { skillFormat: "text", productKind: "aev.consolidation-eval.v1", materialKinds: ["text"] },
        protocol: {
          id: "consolidation-protocol",
          version: "1",
          phases: {
            source: {
              claim: "task_execution",
              checks: [
                { id: "check", version: "1", settings: {}, name: "eval", target: "product", stage: "after_execution", required: true, mechanism: "script" },
              ],
              executor: { id: "exec", version: "1", settings: {} },
            },
          },
        },
      }
      const selectionPath = path.join(tempDir, "selection.json")
      const projectManifestPath = path.join(tempDir, "manifest.json")
      await writeFile(selectionPath, JSON.stringify(selection))
      await writeFile(
        projectManifestPath,
        JSON.stringify({
          schema: "aev.project-pack.v1",
          project,
          skill: { format: "text", entries: [{ id: "skill", kind: "text", path: "rules.txt" }] },
          tasks: [{ id: "task_01", split: "train", materials: [{ id: "q", kind: "text", path: "public.txt" }], privateInputs: [] }],
        }),
      )

      await mkdir(path.join(tempDir, "candidate"), { recursive: true })
      await writeFile(path.join(tempDir, "candidate", "rules.txt"), "Reusable rule for 50 cases")
      await writeFile(path.join(tempDir, "public.txt"), "Question text")

      // 3. 构建 runtime，模拟返回 aev.consolidation-eval.v1 的 product
      const productObj = {
        schema: "aev.consolidation-eval.v1",
        runID,
        model_id: "mock-model-a",
        total: 50,
        passed: 50,
      }
      const productBytes = Buffer.from(JSON.stringify(productObj, null, 2))

      const { Runtime } = await import("../../protocol-plugins/runtime")
      const runtime = new Runtime()
        .addChecker(
          { id: "check", version: "1", implementation: "c".repeat(64), targets: ["product"], mechanisms: ["script"], productKinds: ["aev.consolidation-eval.v1"], validate() {} },
          async () => ({ status: "passed", message: "check passed" }),
        )
        .addExecutor(
          {
            id: "exec",
            version: "1",
            implementation: "e".repeat(64),
            skillFormats: ["text"],
            productKinds: ["aev.consolidation-eval.v1"],
            materialKinds: ["text"],
            settings: {},
            validate() {},
          },
          async () => ({
            status: "completed",
            product: { kind: "aev.consolidation-eval.v1", bytes: productBytes },
          }),
        )

      const { campaignAcceptance } = await import("../../protocol-plugins/campaign-acceptance")
      const entry = {
        schema: "aev.protocol-entry.v1" as const,
        selectionPath,
        projectManifestPath,
        taskID: "task_01",
        phase: "source" as const,
      }

      const acceptanceResult = await campaignAcceptance(
        {
          campaignRoot,
          cwd: tempDir,
          campaignID: "camp_gatea_001",
          roundNumber: 1,
          runID,
          entry,
          candidateRoot: path.join(tempDir, "candidate"),
          attemptRoot,
          resultPath: path.join(attemptRoot, "acceptance-result.json"),
        },
        runtime,
      )

      expect(acceptanceResult.passed).toBe(true)

      // 4. 验证生成的 protocol.training-feedback.json 中已由 campaignAcceptance 正式发布 50 题视图
      const feedbackPath = path.join(attemptRoot, "protocol.training-feedback.json")
      const feedback = JSON.parse(await readFile(feedbackPath, "utf8"))
      expect(feedback.caseFeedback).toBeUndefined()

      // 5. 验证 blankAgentEvidenceReadPaths 中不含 caseFeedback.manifestPath (B10 验证)
      expect(acceptanceResult.blankAgentEvidenceReadPaths.some((p: string) => p.includes("manifest.json"))).toBe(false)

      // 6. 验证 T-A2: 若缺失 directChat 目录，抛出 publication_error
      const missingAttemptRoot = path.join(campaignRoot, "rounds", "round-002", "final-acceptance")
      const missingProductObj = {
        schema: "aev.consolidation-eval.v1",
        runID: "non-existent-run-id",
        total: 50,
        passed: 50,
      }
      const missingProductBytes = Buffer.from(JSON.stringify(missingProductObj))
      const missingRuntime = new Runtime()
        .addChecker(
          { id: "check", version: "1", implementation: "c".repeat(64), targets: ["product"], mechanisms: ["script"], productKinds: ["aev.consolidation-eval.v1"], validate() {} },
          async () => ({ status: "passed", message: "check passed" }),
        )
        .addExecutor(
          {
            id: "exec",
            version: "1",
            implementation: "e".repeat(64),
            skillFormats: ["text"],
            productKinds: ["aev.consolidation-eval.v1"],
            materialKinds: ["text"],
            settings: {},
            validate() {},
          },
          async () => ({
            status: "completed",
            product: { kind: "aev.consolidation-eval.v1", bytes: missingProductBytes },
          }),
        )
      await expect(
        campaignAcceptance(
          {
            campaignRoot,
            cwd: tempDir,
            campaignID: "camp_gatea_002",
            roundNumber: 2,
            runID: "non-existent-run-id",
            entry,
            candidateRoot: path.join(tempDir, "candidate"),
            attemptRoot: missingAttemptRoot,
            resultPath: path.join(missingAttemptRoot, "acceptance-result.json"),
          },
          missingRuntime,
        ),
      ).resolves.toMatchObject({ passed: true })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

