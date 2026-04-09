import { autoEvolvePath, pathExists, readTextFile } from "./fs"
import type { AutoEvolveConfig, LoadedCase } from "./schema"

export type DatasetSplitName = "train" | "test" | "all"

export interface DatasetSplit {
  splitPath: string
  train: string[]
  test: string[]
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export async function loadDatasetSplit(cwd: string, config: AutoEvolveConfig): Promise<DatasetSplit> {
  const splitPath = autoEvolvePath(cwd, config.splitFile)
  if (!(await pathExists(splitPath))) {
    throw new Error(`Dataset split file is missing: ${splitPath}`)
  }

  const raw = await readTextFile(splitPath)
  const train: string[] = []
  const test: string[] = []
  let current: "train" | "test" | undefined

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (/^##\s+train\b/i.test(trimmed)) {
      current = "train"
      continue
    }

    if (/^##\s+test\b/i.test(trimmed)) {
      current = "test"
      continue
    }

    const bullet = trimmed.match(/^-\s+([A-Za-z0-9._-]+)\s*$/)
    if (!bullet || !current) continue

    const caseID = bullet[1]
    if (!caseID) continue
    if (current === "train") train.push(caseID)
    if (current === "test") test.push(caseID)
  }

  return {
    splitPath,
    train: uniqueSorted(train),
    test: uniqueSorted(test),
  }
}

export function selectCasesBySplit(cases: LoadedCase[], split: DatasetSplit, name: DatasetSplitName) {
  if (name === "all") return cases

  const wanted = new Set(name === "train" ? split.train : split.test)
  return cases.filter((item) => wanted.has(item.spec.id))
}
