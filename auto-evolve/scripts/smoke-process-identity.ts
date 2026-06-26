import { spawn } from "node:child_process"
import { identifyProcessOwner, optionalProcessOwnerHints, strongProcessOwnerHints } from "../orchestrator/process-identity"

const child = spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"], {
  windowsHide: true,
  stdio: ["ignore", "ignore", "ignore"],
})

try {
  if (!child.pid) throw new Error("Failed to spawn smoke process.")

  const owned = await identifyProcessOwner({
    pid: child.pid,
    commandHints: ["Start-Sleep", "powershell"],
    staleAfterMs: 60_000,
    updatedAt: new Date().toISOString(),
  })
  if (!owned.alive || owned.ownership !== "owned") {
    throw new Error(`Expected owned process, got ${JSON.stringify(owned)}`)
  }

  const requiredAny = await identifyProcessOwner({
    pid: child.pid,
    requiredAnyCommandHints: ["definitely-not-this-command-line-hint", "Start-Sleep"],
    optionalCommandHints: ["not-required"],
    staleAfterMs: 60_000,
    updatedAt: new Date().toISOString(),
  })
  if (!requiredAny.alive || requiredAny.ownership !== "owned") {
    throw new Error(`Expected requiredAny owned process, got ${JSON.stringify(requiredAny)}`)
  }

  const optionalOnly = await identifyProcessOwner({
    pid: child.pid,
    optionalCommandHints: ["Start-Sleep"],
    staleAfterMs: 60_000,
    updatedAt: new Date().toISOString(),
  })
  if (optionalOnly.ownership === "owned") {
    throw new Error(`Optional hints must not prove ownership, got ${JSON.stringify(optionalOnly)}`)
  }

  const genericRequiredHints = strongProcessOwnerHints(["run-long-task-campaign"])
  const genericOptionalHints = optionalProcessOwnerHints(["run-long-task-campaign"])
  if (genericRequiredHints.length !== 0 || genericOptionalHints.length !== 1) {
    throw new Error(
      `Generic owner hint filtering failed: ${JSON.stringify({ genericRequiredHints, genericOptionalHints })}`,
    )
  }

  const genericOnly = await identifyProcessOwner({
    pid: child.pid,
    requiredAnyCommandHints: genericRequiredHints,
    optionalCommandHints: genericOptionalHints,
    staleAfterMs: 60_000,
    updatedAt: new Date().toISOString(),
  })
  if (genericOnly.ownership === "owned") {
    throw new Error(`Generic hints must not prove ownership, got ${JSON.stringify(genericOnly)}`)
  }

  if (owned.creationTick) {
    const wrongTick = await identifyProcessOwner({
      pid: child.pid,
      requiredAnyCommandHints: ["Start-Sleep"],
      expectedCreationTick: `${owned.creationTick}-wrong`,
      staleAfterMs: 60_000,
      updatedAt: new Date().toISOString(),
    })
    if (wrongTick.ownership !== "wrong_owner") {
      throw new Error(`Expected wrong_owner for mismatched creation tick, got ${JSON.stringify(wrongTick)}`)
    }
  }

  const wrong = await identifyProcessOwner({
    pid: child.pid,
    commandHints: ["definitely-not-this-command-line-hint"],
    staleAfterMs: 60_000,
    updatedAt: new Date().toISOString(),
  })
  if (process.platform === "win32" && wrong.ownership !== "wrong_owner") {
    throw new Error(`Expected wrong_owner on Windows, got ${JSON.stringify(wrong)}`)
  }

  const dead = await identifyProcessOwner({ pid: 99999999, commandHints: ["anything"] })
  if (dead.alive || dead.ownership !== "dead") {
    throw new Error(`Expected dead process, got ${JSON.stringify(dead)}`)
  }

  console.log(JSON.stringify({ ok: true, owned: owned.ownership, wrong: wrong.ownership, dead: dead.ownership }, null, 2))
} finally {
  child.kill()
}
