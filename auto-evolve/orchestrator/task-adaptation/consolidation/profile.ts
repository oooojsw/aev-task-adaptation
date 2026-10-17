import path from "node:path"
import { writeFile } from "node:fs/promises"
import { validateCatalogue, type TaskCatalogue, type Profile } from "../catalogue"
import { freezeSources, sanitizeAuthorSources } from "./source-manifest"
import { CONSOLIDATION_PROFILE_ID } from "./contract"

// An opt-in profile; host must separately bind an approved evaluator and checker.
export function consolidationProfile(entry: string, capability: string): Profile {
  if (!/^[A-Za-z][\w.-]*$/.test(entry) || !/^[A-Za-z][\w.-]*$/.test(capability)) {
    throw new Error("Invalid consolidation resource or capability ID")
  }
  return {
    id: CONSOLIDATION_PROFILE_ID,
    description: "Evolve one <=5000-character Skill using independent one-turn Direct Chat cases and trusted pass_rate scoring.",
    kinds: ["skill"],
    requires: [capability],
    acceptance: {
      execution: "script",
      checks: [
        { id: "consolidation_surface", target: "candidate", mechanism: "script", purpose: "Reject overlength and invalid Skill before model requests", required: true, resources: [entry], feedback: "message" },
        { id: "consolidation_score", target: "product", mechanism: "script", purpose: "Verify all independent Direct Chat verdicts and their immutable run identity", required: true, resources: [entry], feedback: "message" },
      ],
    },
    rejection: [
      { check: "consolidation_surface", actions: ["repair"] },
      { check: "consolidation_score", actions: ["repair"] },
    ],
    selection: { rule: "best_pass", metric: "pass_rate", direction: "max" },
  }
}

 
// Host-only builder. It makes each Skill a frozen, read-only training resource;
// the independent evaluator receives only the public candidate publication.
export async function consolidationCatalogue(input: {
  root: string
  manifest: string
  cases: string[]
  id: string
  objective: string
  stop: TaskCatalogue["stop"]
  authorIndexFile?: string
}) {
  const files = await freezeSources(input.root, input.manifest, input.cases)
  const relative = (file: string) => path.relative(input.root, file).replace(/\\/g, "/")
  const entries = [{ id: "merged_skill", path: "DIRECT_CHAT.md", audience: "public" as const, mutable: true }]
  const sources = files.map(row => ({
    id: `source_${row.id}`, path: relative(row.path), audience: "training" as const, mutable: false,
  }))
  const authorIndexName = input.authorIndexFile ?? "author-source-index.json"
  const authorIndexPath = path.resolve(input.root, authorIndexName)
  const authorManifest = sanitizeAuthorSources(files.map(row => ({
    id: row.id,
    path: relative(row.path),
    sha256: row.sha256,
  })))
  await writeFile(authorIndexPath, JSON.stringify(authorManifest, null, 2), "utf8")
  const index = relative(authorIndexPath)
  const catalogue: TaskCatalogue = {
    id: input.id,
    request: input.objective,
    resources: [...entries, { id: "source_index", path: index, audience: "training", mutable: false }, ...sources],
    entries: ["merged_skill"],
    capabilities: [{ id: "consolidation_author", version: "1",
      description: "Read frozen Skills, deduplicate and edit the candidate publication",
      actions: ["read", "edit", "optimize", "repair"], available: true }],
    profiles: [consolidationProfile("merged_skill", "consolidation_author")],
    stop: input.stop,
    maxWorkers: 4,
  }
  return validateCatalogue(catalogue)
}
