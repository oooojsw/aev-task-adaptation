import path from "node:path"
import { autoEvolvePath, pathExists, readTextFile } from "./fs"
import type { AutoEvolveConfig } from "./schema"
import { isMethodPrimitiveOp, type MethodPrimitiveOp } from "./primitives"

export type MethodPromptPhase =
  | "bootstrap"
  | "solve"
  | "maintain_extension"
  | "judge_extension"
  | "adversarial_probe"
  | "select"

export interface MethodPaths {
  id: string
  root: string
  methodDocPath: string
  flowPath: string
  promptDir: string
}

export interface MethodFlowStep {
  op: MethodPrimitiveOp
}

export interface MethodFlow {
  id: string
  steps: MethodFlowStep[]
  flowPath: string
}

export function methodPaths(cwd: string, config: AutoEvolveConfig, methodID?: string): MethodPaths {
  const id = methodID ?? config.defaultMethod
  const root = autoEvolvePath(cwd, config.methodsDir, id)
  return {
    id,
    root,
    methodDocPath: path.join(root, "METHOD.md"),
    flowPath: path.join(root, "FLOW.md"),
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
  if (!(await pathExists(paths.flowPath))) {
    throw new Error(`Method flow is missing: ${paths.flowPath}`)
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

export async function readMethodFlow(paths: MethodPaths): Promise<MethodFlow> {
  await assertMethodExists(paths)
  const raw = await readTextFile(paths.flowPath)
  const steps = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(isMethodPrimitiveOp)
    .map((op) => ({ op }))

  if (!steps.length) {
    throw new Error(`Method flow contains no recognized primitive ops: ${paths.flowPath}`)
  }

  return {
    id: paths.id,
    steps,
    flowPath: paths.flowPath,
  }
}
