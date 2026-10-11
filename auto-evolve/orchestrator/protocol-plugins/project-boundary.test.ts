import { expect, test } from "bun:test"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { randomUUID, createHash } from "node:crypto"
import path from "node:path"

const baseline = "7d8b7d36d4f5357fb69b4079393cd4f3e28d2293"
const repo = path.resolve(import.meta.dir, "../../..")
const projectTerms = /\bnba(?:\b|_)|rulearena|official-scorer|basketball|projects[\\/]nba/i

test("new core has no NBA-specific implementation; pre-existing legacy adapter stays identical", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "auto-evolve/orchestrator", "auto-evolve/cli.ts"], { cwd: repo })
  expect(listed.exitCode).toBe(0)
  const files = listed.stdout.toString().trim().split(/\r?\n/)
    .filter((file) => /\.(ts|py)$/.test(file) && !file.endsWith(".test.ts"))
  const observations: Array<{ file: string; sha256: string; projectTerm: boolean; legacyException: boolean }> = []
  for (const file of files) {
    const bytes = await readFile(path.join(repo, file))
    const projectTerm = projectTerms.test(bytes.toString("utf8"))
    const legacyException = file === "auto-evolve/orchestrator/blank-eval/single-turn.ts"
    // 旧适配行为不迁移；新核心不得借此增加项目特例。
    if (legacyException) {
      const old = Bun.spawnSync(["git", "show", `${baseline}:${file}`], { cwd: repo })
      expect(old.exitCode).toBe(0)
      expect(bytes.equals(old.stdout)).toBe(true)
      expect(projectTerm).toBe(true)
    } else expect(projectTerm, file).toBe(false)
    observations.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"), projectTerm, legacyException })
  }
  expect(files.length).toBeGreaterThan(100)
  expect(observations.filter((row) => row.projectTerm)).toHaveLength(1)
  const evidence = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  await mkdir(evidence, { recursive: true })
  await writeFile(path.join(evidence, "project-boundary.json"), JSON.stringify({ baseline, observations,
    limitation: "Tracked core source lexical audit; generic behavior still requires lifecycle tests." }, null, 2))
})
