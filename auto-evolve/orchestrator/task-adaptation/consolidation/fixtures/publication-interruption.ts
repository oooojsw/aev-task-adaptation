import { mock } from "bun:test"
import path from "node:path"
import * as atomic from "../../../atomic-write"

const write = atomic.writeFileAtomic
const timer = setInterval(() => {}, 1000)
mock.module("../../../atomic-write", () => ({
  ...atomic,
  writeFileAtomic: async (...args: Parameters<typeof write>) => {
    await write(...args)
    // 只阻塞真实磁盘写完后的时序，发布器和进程锁仍用真实实现。
    const stage = process.argv[4] ?? "case"
    if (stage === "case" ? path.basename(args[0]).startsWith("case_") : path.basename(args[0]) === stage) {
      process.stdout.write("checkpoint\n")
      await new Promise(() => {})
    }
  },
}))
const { publishTrainingFeedbackResource } = await import("../feedback-publisher")
await publishTrainingFeedbackResource({
  targetDir: process.argv[2],
  campaignID: "campaign",
  round: 1,
  recoverIncomplete: process.argv[3] === "recover",
  cases: Array.from({ length: 50 }, (_, i) => ({
    caseID: `case_${i}`,
    prompt: `Public question ${i}`,
    modelResponse: `Actual answer ${i}`,
    passed: i < 43,
    score: i < 43 ? 1 : 0,
  })),
})
clearInterval(timer)
