import path from "node:path"
import { writeRunDashboard } from "../orchestrator/run-health"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const autoRoot = path.join(repoRoot, "auto-evolve")
const campaignRoot = path.join(autoRoot, "runtime-state", "long-task-campaigns")
const dashboardRoot = path.join(autoRoot, "runtime-state", "run-dashboard")

async function main() {
  const summary = await writeRunDashboard({
    campaignRoot,
    dashboardRoot,
    label: process.env.AUTO_EVOLVE_DASHBOARD_LABEL,
    phase: process.env.AUTO_EVOLVE_DASHBOARD_PHASE,
  })
  console.log(`dashboard updated: ${path.join(dashboardRoot, "active-runs.md")}`)
  console.log(JSON.stringify(summary.counts, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
