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
      title: `Direct Chat Training Case ${i}`,
      prompt: `Prompt for case ${i}: Please synthesize guidance on task adaptation topic ${i}.`,
      materials: [
        { id: `mat_${i}`, name: `sample_${i}.txt`, content: `Reference material text for case ${i}` },
      ],
      modelResponse: `Model drafted response for case ${i}.`,
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

describe("AEV Unified Access & 50-Case Feedback Permissions (P0-P3)", () => {
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
          campaignID: "camp_sanitize",
          round: 1,
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

  test("U02 & U10: AuthorizeInvocation injects all 50 cases into permissionReadPaths for worker and lead", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-invocation-grant-test-"))
    try {
      const rawCases = generateMockCases(50, 43)
      const { logicalResource } = await publishTrainingFeedbackResource({
        targetDir: tempDir,
        campaignID: "camp_invocation",
        round: 1,
        cases: rawCases,
      })

      // 构建一个合法的 Task-Adaptation Plan
      const candidateDir = path.join(tempDir, "candidate")
      await mkdir(candidateDir, { recursive: true })

      const sampleSkillPath = path.join(candidateDir, "DIRECT_CHAT.md")
      await writeFile(sampleSkillPath, "# Sample Direct Chat Guidance\nInitial content\n", "utf8")
      const sampleAssetPath = path.join(candidateDir, "task_spec.txt")
      await writeFile(sampleAssetPath, "Task spec definition\n", "utf8")

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
        workers: [],
        selection: { rule: "first_pass" },
        stop: { rounds: 2, calls: 10, tokens: 10000, stagnant: 1 },
      }

      const bound = await bindPlan(candidateDir, plan, ["read"])

      // 测试 Lead 角色调用授权
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

      // 验证全部 50 个 case 视图文件以及 manifest 均进入 permissionReadPaths
      expect(leadResult.request.permissionReadPaths.length).toBeGreaterThanOrEqual(51)
      expect(leadResult.request.permissionEditPaths).toEqual([sampleSkillPath.replaceAll("\\", "/")])
      expect(leadResult.scope.feedbackResource?.resourceID).toBe(logicalResource.resourceID)

      // 测试缺少 runtime: feedback 的角色被统一授权拒绝
      const planWithoutFeedback: Plan = {
        ...plan,
        windows: [
          {
            ...plan.windows[0],
            runtime: [], // 去除 feedback runtime
          },
          plan.windows[1],
        ],
      }
      const boundWithoutFeedback = await bindPlan(candidateDir, planWithoutFeedback, ["read"])

      await expect(
        authorizeInvocation(
          {
            bound: boundWithoutFeedback,
            role: "lead",
            stage: "revise",
            output: "Output",
            maxInlineBytes: 10000,
            feedbackResource: logicalResource,
          },
          { model: "mock-model", config: { permissionConfig: { version: 1, mode: "restricted" } } },
        ),
      ).rejects.toThrow("Unified access denied for feedbackResource: RUNTIME_NOT_PERMITTED")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("U04 & U06: Scoped reader supports chunked pagination of large cases (>8MiB) with EOF and hash preservation", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "aev-large-case-reader-test-"))
    try {
      // 构造一个约 9 MiB 的超大长文本（测试超过 8 MiB 单文件限制的分页流式读取）
      const largeChunk = "0123456789ABCDEF".repeat(64) // 1024 字节
      const repeatCount = 9 * 1024 // 9 MB
      const largeContent = largeChunk.repeat(repeatCount)

      const rawCases: RawTestCaseResult[] = [
        {
          caseID: "dc_huge_001",
          title: "Huge Context Case",
          prompt: "Huge Case Prompt",
          materials: [{ id: "mat_huge", name: "huge.txt", content: largeContent }],
          modelResponse: "Response to huge case",
          score: 1.0,
          passed: true,
          diagnostics: ["Passed huge verification"],
        },
      ]

      const { manifest, logicalResource } = await publishTrainingFeedbackResource({
        targetDir: tempDir,
        campaignID: "camp_huge",
        round: 1,
        cases: rawCases,
      })

      const readerBinding = bindScopedReader(logicalResource, manifest)
      expect(readerBinding.allowedCases.has("dc_huge_001")).toBe(true)

      // 通过 ScopedReader 循环逐页分段读取，直到 EOF
      const collectedChunks: string[] = []
      let cursor: string | undefined = undefined
      let totalReadBytes = 0
      let pageCount = 0

      while (true) {
        pageCount++
        const chunkResult = await readResourceChunk(readerBinding, {
          resourceID: logicalResource.resourceID,
          caseID: "dc_huge_001",
          cursor,
          maxBytes: 64000, // 每次 64 KB 分段
        })

        collectedChunks.push(chunkResult.data)
        totalReadBytes += chunkResult.returnedBytes

        if (chunkResult.eof) {
          expect(chunkResult.nextCursor).toBeUndefined()
          break
        }
        expect(chunkResult.nextCursor).toBeDefined()
        cursor = chunkResult.nextCursor
      }

      expect(pageCount).toBeGreaterThan(100) // 9MB / 64KB 应该超过 140 页
      const reconstructed = collectedChunks.join("")
      expect(Buffer.byteLength(reconstructed, "utf8")).toBe(totalReadBytes)

      // 验证重组后的内容与落盘文件完全一致
      const diskCaseContent = await readFile(path.join(tempDir, "cases", "case_dc_huge_001.json"), "utf8")
      expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(
        createHash("sha256").update(diskCaseContent).digest("hex"),
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test("U08 & U13: Forged cursor, unknown caseID and boundary escape are strictly rejected", async () => {
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

      // 2. 伪造 cursor 拒绝
      const forgedCursor = Buffer.from(
        JSON.stringify({
          resourceID: logicalResource.resourceID,
          caseID: "dc_001",
          version: "v999.fake",
          offset: 999999999,
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
          campaignID: "camp_reject",
          round: 1,
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
})
