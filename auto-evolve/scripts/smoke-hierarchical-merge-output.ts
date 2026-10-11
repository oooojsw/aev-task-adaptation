import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { auditMergeOutput, leafSourceIDs } from "../orchestrator/multi-instance/merge-output-validation"

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

const root = await mkdtemp(path.join(tmpdir(), "aev-merge-output-"))
try {
  const output = path.join(root, "output")
  const contract = path.join(root, "contract.json")
  await mkdir(output)
  await writeFile(contract, JSON.stringify({
    requiredFiles: ["CORE.md", "PROVENANCE.json", "casebook/"],
    provenanceRequirements: { routingRules: true },
  }))
  const empty = await auditMergeOutput({ outputDir: output, contractPath: contract, expectedSourceIDs: ["UID0001"] })
  assert(!empty.passed && empty.missing.includes("CORE.md"), "empty merge output was accepted")

  await mkdir(path.join(output, "casebook"))
  await writeFile(path.join(output, "CORE.md"), "# Method\n")
  await writeFile(path.join(output, "casebook", "method.md"), "# Procedure\n")
  await writeFile(path.join(output, "PROVENANCE.json"), JSON.stringify({ sourceIDs: ["UID0002"] }))
  const missingSource = await auditMergeOutput({
    outputDir: output,
    contractPath: contract,
    expectedSourceIDs: ["UID0001", "UID0002"],
  })
  assert(!missingSource.passed && missingSource.missingSourceIDs.includes("UID0001"), "dropped source was accepted")

  await writeFile(path.join(output, "PROVENANCE.json"), JSON.stringify({ sourceIDs: ["UID0001", "UID0002"] }))
  const valid = await auditMergeOutput({
    outputDir: output,
    contractPath: contract,
    expectedSourceIDs: ["UID0001", "UID0002"],
  })
  assert(valid.passed, "complete merge output was rejected")

  const child = path.join(root, "child")
  await mkdir(path.join(child, "output"), { recursive: true })
  await writeFile(path.join(child, "input-manifest.json"), JSON.stringify({
    inputs: [{ id: "UID0001", sourceKind: "instance" }, { id: "UID0002", sourceKind: "instance" }],
  }))
  const leafIDs = await leafSourceIDs([{ id: "group-1", sourceKind: "merged_group", skillPath: path.join(child, "output") }])
  assert(JSON.stringify(leafIDs) === JSON.stringify(["UID0001", "UID0002"]), "nested lineage was lost")
  assert((await readFile(path.join(output, "CORE.md"), "utf8")).length > 0, "fixture was not written")
  console.log("smoke-hierarchical-merge-output: passed")
} finally {
  // 只清理本测试刚创建的临时目录。
  if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true })
}
