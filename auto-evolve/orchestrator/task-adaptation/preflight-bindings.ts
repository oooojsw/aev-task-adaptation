import type { Registry } from "../protocol-plugins/registry"
import type { Binding, Settings } from "../protocol-plugins/contract"
import { verifyScriptExecution } from "../protocol-plugins/script-executor"
import { verifyScriptChecker } from "../protocol-plugins/script-checker"

export async function preflightBindings(input: { executor?: Binding; checkers: Array<{ name: string; binding: Binding }> },
  registry: Registry, credential: (name: string) => string | undefined = name => process.env[name]) {
  const evidence: Array<{ id: string; version: string; checks: string[] }> = []
  const checkCredential = (settings: Settings) => {
    const alias = settings.credentialEnv
    if (typeof alias !== "string" || !credential(alias)) throw new Error("Missing selected credential reference before task interpretation")
  }
  for (const item of [...(input.executor ? [{ binding: input.executor, executor: true }] : []),
    ...input.checkers.map(item => ({ binding: item.binding, executor: false }))]) {
    const binding = item.binding
    const descriptor = item.executor ? registry.executor(binding) : registry.checker(binding)
    descriptor.validate(binding.settings)
    const checks = ["registered_plugin", "settings_valid"]
    if (binding.id === "script-json-executor") { await verifyScriptExecution(binding.settings); checks.push("local_dependency_hashes") }
    if (binding.id === "script-json-checker") { await verifyScriptChecker(binding.settings); checks.push("local_dependency_hashes") }
    if (binding.id === "http-text-chat") { checkCredential(binding.settings); checks.push("credential_reference_present") }
    if (binding.id === "http-model-judge") { checkCredential(binding.settings.http as Settings); checks.push("credential_reference_present") }
    // 本地依赖检查不冒充远端接口或额度可用证明。
    evidence.push({ id: binding.id, version: binding.version, checks })
  }
  return evidence
}
