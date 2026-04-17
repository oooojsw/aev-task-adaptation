const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")

const outputDir =
  "C:/Users/ZhuAnZ/Desktop/opencode re/opencode latest/auto-evolve/task-packs/real-long-tasks/try4-expert-bootstrap/deployment/outputs"

// Verify files exist
const reportPath = path.join(outputDir, "generated-report.docx")
const explanationPath = path.join(outputDir, "generated-explanation.docx")

console.log("=== Output Files Verification ===")
console.log("Report exists:", fs.existsSync(reportPath))
console.log("Explanation exists:", fs.existsSync(explanationPath))

if (fs.existsSync(reportPath)) {
  console.log("Report size:", fs.statSync(reportPath).size, "bytes")
}
if (fs.existsSync(explanationPath)) {
  console.log("Explanation size:", fs.statSync(explanationPath).size, "bytes")
}

// Check for remaining placeholders using PowerShell to unzip and check
function checkPlaceholdersInDocx(docxPath, name) {
  return new Promise((resolve, reject) => {
    const tempDir = docxPath + ".check"
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true })
    }
    fs.mkdirSync(tempDir, { recursive: true })

    const psCode = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead('${docxPath.replace(/'/g, "''")}')
$entries = $archive.Entries
foreach ($entry in $entries) {
  if ($entry.FullName -eq 'word/document.xml') {
    $entry.ExtractToFile('${tempDir.replace(/'/g, "''")}/document.xml', $true)
    break
  }
}
$archive.Dispose()
Write-Host 'Extracted'
`
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCode], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    ps.on("close", (code) => {
      if (code === 0) {
        const docPath = path.join(tempDir, "document.xml")
        if (fs.existsSync(docPath)) {
          const content = fs.readFileSync(docPath, "utf8")
          const beforeCount = (content.match(/\u3010/g) || []).length
          const afterCount = (content.match(/\u3011/g) || []).length
          console.log(`\n=== ${name} Placeholder Check ===`)
          console.log(`  U+3010 (【) count: ${beforeCount}`)
          console.log(`  U+3011 (】) count: ${afterCount}`)
          console.log(`  Placeholders remaining: ${beforeCount > 0 ? "YES - FAIL" : "NONE - PASS"}`)
        }
        fs.rmSync(tempDir, { recursive: true })
        resolve()
      } else {
        reject(new Error("PowerShell exited with code " + code))
      }
    })
  })
}

async function verify() {
  await checkPlaceholdersInDocx(reportPath, "Report")
  await checkPlaceholdersInDocx(explanationPath, "Explanation")

  console.log("\n=== Deployment Output Path ===")
  console.log("Report:", reportPath)
  console.log("Explanation:", explanationPath)
}

verify().catch(console.error)
