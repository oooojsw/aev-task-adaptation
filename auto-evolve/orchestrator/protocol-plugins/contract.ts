export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Settings = { [key: string]: Json }
export type Phase = "source" | "merge" | "replay" | "test"
export type Target = "skill" | "product"
export type Stage = "before_execution" | "after_execution"
export type Outcome = "passed" | "rejected" | "execution_error" | "scoring_error" | "data_error" | "interrupted"

export interface Identity {
  id: string
  version: string
}

export interface Binding extends Identity {
  settings: Settings
}

export interface Project extends Identity {
  skillFormats: string[]
  productKinds: string[]
  materialKinds: string[]
}

export interface Check extends Binding {
  name: string
  target: Target
  stage: Stage
  required: boolean
  mechanism: "script" | "judge"
  privateInputs?: string[]
  feedback?: "status_only" | "checker_message"
}

export interface PhaseProtocol {
  claim: "skill_check" | "task_execution"
  executor?: Binding
  checks: Check[]
}

export interface Protocol extends Identity {
  phases: Partial<Record<Phase, PhaseProtocol>>
}

export interface Selection {
  schema: "aev.protocol-plugins.v1"
  project: Project
  protocol: Protocol
  run: {
    skillFormat: string
    productKind: string
    materialKinds: string[]
  }
}

export interface ExecutorPlugin extends Identity {
  implementation: string
  skillFormats: string[]
  productKinds: string[]
  materialKinds: string[]
  validate(settings: Settings): void
}

export interface CheckerPlugin extends Identity {
  implementation: string
  targets: Target[]
  mechanisms: Array<Check["mechanism"]>
  productKinds: string[]
  validate(settings: Settings): void
}

export interface Snapshot {
  schema: "aev.protocol-snapshot.v1"
  selection: Selection
  implementations: {
    executors: ExecutorPluginDescriptor[]
    checkers: CheckerPluginDescriptor[]
  }
  fingerprint: string
}

export type ExecutorPluginDescriptor = Omit<ExecutorPlugin, "validate">
export type CheckerPluginDescriptor = Omit<CheckerPlugin, "validate">
