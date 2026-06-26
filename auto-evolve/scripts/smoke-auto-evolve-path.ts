import path from "node:path"
import { autoEvolvePath } from "../orchestrator/fs"

function normalize(input: string) {
  return path.resolve(input).replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase()
}

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoEvolveRoot = path.join(repoRoot, "auto-evolve")
const expected = path.join(autoEvolveRoot, "runtime-state")

const cases = [
  { label: "repo-root", cwd: repoRoot },
  { label: "auto-evolve-root", cwd: autoEvolveRoot },
  { label: "auto-evolve-dot", cwd: path.join(autoEvolveRoot, ".") },
]

for (const item of cases) {
  const actual = autoEvolvePath(item.cwd, "runtime-state")
  if (normalize(actual) !== normalize(expected)) {
    throw new Error(`${item.label}: expected ${expected}, got ${actual}`)
  }
}

console.log(JSON.stringify({ passed: true, expected, cases: cases.map((item) => item.label) }, null, 2))
