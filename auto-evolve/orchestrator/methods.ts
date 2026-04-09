import path from "node:path"
import { autoEvolvePath, pathExists, readTextFile } from "./fs"
import type { AutoEvolveConfig } from "./schema"

export type MethodPromptPhase = "bootstrap" | "solve" | "refine" | "adversarial_probe" | "select"

export interface MethodPaths {
  id: string
  root: string
  methodDocPath: string
  promptDir: string
}

export function methodPaths(cwd: string, config: AutoEvolveConfig, methodID?: string): MethodPaths {
  const id = methodID ?? config.defaultMethod
  const root = autoEvolvePath(cwd, config.methodsDir, id)
  return {
    id,
    root,
    methodDocPath: path.join(root, "METHOD.md"),
    promptDir: path.join(root, "prompts"),
  }
}

export async function assertMethodExists(paths: MethodPaths) {
  if (!(await pathExists(paths.root))) {
    throw new Error(`Method directory is missing: ${paths.root}`)
  }
  if (!(await pathExists(paths.methodDocPath))) {
    throw new Error(`Method definition is missing: ${paths.methodDocPath}`)
  }
}

export async function readMethodPrompt(paths: MethodPaths, phase: MethodPromptPhase) {
  await assertMethodExists(paths)
  const target = path.join(paths.promptDir, `${phase}.md`)
  if (!(await pathExists(target))) {
    throw new Error(`Method prompt is missing: ${target}`)
  }
  return readTextFile(target)
}
