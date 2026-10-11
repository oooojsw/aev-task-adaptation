import path from "node:path"
import { ensureLayout } from "../orchestrator/fs"
import { loadConfig } from "../orchestrator/schema"
import { resumeLongTaskCampaign } from "../orchestrator/long-task-campaign/runner"

async function main() {
  const cwd = path.resolve("..")
  const campaignID = "20260709-182628309-71d65677-docx-format-transfer-0708-campaign"
  const specPath = path.resolve(
    "task-packs/real-long-tasks/docx-format-transfer-learnbench/tasks/docx-format-0708/campaign.json",
  )
  console.log("cwd", cwd)
  console.log("spec", specPath)
  console.log("step ensureLayout")
  await ensureLayout(cwd)
  console.log("step loadConfig")
  await loadConfig(cwd)
  console.log("step resume")
  const result = await resumeLongTaskCampaign({ cwd, campaignID, specPath })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
