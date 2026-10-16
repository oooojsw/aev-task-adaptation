import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { computeExpression, recompute, recomputeEnvironment, recomputeFromEnvironment, validateRecomputeAccess } from "./recompute"

const scope = { schema: "aev.recompute.v1" as const, task: "a".repeat(64), role: "executor" }
const expression = { op: "mul", args: [{ op: "div", args: [{ op: "sub", args: [120, 100] }, 100] }, 100] }

test("bounded arithmetic computes actual nested numerical results without evaluating code", () => {
  expect(computeExpression(expression)).toBe(20)
  expect(computeExpression({ op: "mean", args: [10, 20, 30] })).toBe(20)
  expect(computeExpression({ op: "sqrt", args: [{ op: "pow", args: [3, 2] }] })).toBe(3)
  expect(computeExpression({ op: "sum", args: [1, 2, 3] })).toBe(6)
  expect(computeExpression({ op: "min", args: [3, 1] })).toBe(1)
  expect(computeExpression({ op: "max", args: [3, 1] })).toBe(3)
  expect(computeExpression(0)).toBe(0)
  for (const invalid of ["process.exit()", { code: "1+1" }, { op: "eval", args: [1] }, { op: "add", args: [] },
    { op: "div", args: [1, 0] }, { op: "sqrt", args: [-1] }, NaN, Infinity,
    { op: "pow", args: [1, 1025] }, { op: "mul", args: [1e308, 1e308] },
    { op: "sub", args: [1] }, { op: "sqrt", args: [1, 2] }, { op: "add", args: [1], path: "private.txt" }]) {
    expect(() => computeExpression(invalid)).toThrow()
  }
})

test("depth, fanout and total expression nodes are finite", () => {
  expect(() => computeExpression({ op: "sum", args: Array(129).fill(1) })).toThrow("arity")
  let deep: unknown = 1
  for (let i = 0; i < 18; i++) deep = { op: "sqrt", args: [deep] }
  expect(() => computeExpression(deep)).toThrow("complexity")
  expect(() => computeExpression({ op: "sum", args: Array(128).fill({ op: "add", args: [1, 2] }) })).toThrow("complexity")
})

test("calculation receipts preserve exact arguments and disclose unverified input origins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-recompute-"))
  const result = await recompute({ ...scope, evidenceRoot: root }, expression)
  const [file] = await readdir(root)
  const receipt = JSON.parse(await readFile(path.join(root, file), "utf8"))
  expect(result.result).toBe(20)
  expect(receipt).toMatchObject({ result: 20, expression, arithmetic: "IEEE-754-binary64", inputOrigin: "model_arguments_not_source_verified" })
  expect(receipt.fingerprint).toBe(result.receipt)
  await expect(recompute({ ...scope, evidenceRoot: root }, expression, AbortSignal.abort())).rejects.toThrow()
  expect(await readdir(root)).toHaveLength(1)
})

test("private binding is hash-frozen, bounded and cleared when not selected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-recompute-env-"))
  const configRoot = path.join(root, "config")
  await mkdir(configRoot)
  const cfg = { ...scope, evidenceRoot: path.join(root, "evidence") }
  const env = await recomputeEnvironment(cfg, configRoot)
  expect((await recomputeFromEnvironment(expression, env)).result).toBe(20)
  await writeFile(env.OPENCODE_AEV_RECOMPUTE_FILE!, JSON.stringify({ ...cfg, role: "lead" }))
  await expect(recomputeFromEnvironment(expression, env)).rejects.toThrow("binding drift")
  const absent = await recomputeEnvironment(undefined, configRoot)
  expect(absent.OPENCODE_AEV_RECOMPUTE_FILE).toBeUndefined()
  await expect(recomputeFromEnvironment(expression, absent)).rejects.toThrow("Explicit frozen")
  expect(() => validateRecomputeAccess(scope, [root], [], path.join(root, "evidence"))).toThrow("outside model grants")
  expect(() => validateRecomputeAccess(scope, [], [root], path.join(root, "evidence"))).toThrow()
  expect(() => validateRecomputeAccess(scope, [], [], path.join(os.tmpdir(), "outside"))).not.toThrow()
})
