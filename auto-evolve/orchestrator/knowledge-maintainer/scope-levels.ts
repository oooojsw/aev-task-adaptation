export interface KnowledgeMaintainerScopeLevel {
  id: string
  title: string
  summary: string
  guidance: string[]
}

const FULL_ACCESS_SCOPE: KnowledgeMaintainerScopeLevel = {
  id: "full-access",
  title: "Full Access",
  summary:
    "Default maintenance scope. The maintainer may reshape any Markdown part of the current experience workspace as needed.",
  guidance: [
    "Treat the whole current experience workspace as editable.",
    "You may revise structure, content, navigation, and partitions if the method guidance supports it.",
    "This scope level is currently descriptive only; it is not yet a hard permission wall.",
  ],
}

const BUILTIN_SCOPE_LEVELS = [FULL_ACCESS_SCOPE]

export function listKnowledgeMaintainerScopeLevels() {
  return [...BUILTIN_SCOPE_LEVELS]
}

export function resolveKnowledgeMaintainerScopeLevel(scopeLevelID?: string) {
  const target = scopeLevelID ?? FULL_ACCESS_SCOPE.id
  const found = BUILTIN_SCOPE_LEVELS.find((item) => item.id === target)
  if (!found) {
    throw new Error(`Unknown knowledge maintainer scope level: ${target}`)
  }
  return found
}
