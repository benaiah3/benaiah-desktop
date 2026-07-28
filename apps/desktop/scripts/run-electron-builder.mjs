// Resolve electronDist at runtime (#38673, #47917): electron-builder 26.8.x can
// re-unpack a broken Electron.app; reusing the installed dist dodges that.
// npm workspace hoisting is non-deterministic — require.resolve finds electron
// wherever it landed. Dist present → -c.electronDist=<abs>/dist; absent → let
// electron-builder fetch via @electron/get (electronVersion + ELECTRON_MIRROR).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

function electronDistDir() {
  try {
    return path.join(path.dirname(require.resolve("electron/package.json")), "dist")
  } catch {
    return null
  }
}

function distBinary(dist) {
  if (process.platform === "darwin") {
    return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron")
  }
  if (process.platform === "win32") {
    return path.join(dist, "electron.exe")
  }
  return path.join(dist, "electron")
}

function electronBuilderCli() {
  const pkgJson = require.resolve("electron-builder/package.json")
  const bin = require(pkgJson).bin
  const rel = typeof bin === "string" ? bin : bin["electron-builder"]
  return path.join(path.dirname(pkgJson), rel)
}

const dist = electronDistDir()
const args = []
const childEnv = { ...process.env }

if (process.platform === "darwin" && !childEnv.CSC_KEYCHAIN) {
  const signingDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Benaiah",
    "Signing"
  )
  const keychain = path.join(
    os.homedir(),
    "Library",
    "Keychains",
    "BenaiahSigning.keychain-db"
  )
  const passwordFile = path.join(signingDir, "benaiah-signing-keychain.password")

  if (fs.existsSync(keychain) && fs.existsSync(passwordFile)) {
    const password = fs.readFileSync(passwordFile, "utf8").trim()
    const unlock = spawnSync(
      "/usr/bin/security",
      ["unlock-keychain", "-p", password, keychain],
      { stdio: "ignore" }
    )
    if (unlock.status !== 0) {
      console.error("[run-electron-builder] unable to unlock Benaiah signing keychain")
      process.exit(unlock.status == null ? 1 : unlock.status)
    }
    childEnv.CSC_KEYCHAIN = keychain
    childEnv.APPLE_NOTARY_PROFILE ||= "benaiah-notary"
    childEnv.APPLE_NOTARY_KEYCHAIN = keychain
  }
}

if (dist && fs.existsSync(distBinary(dist))) {
  args.push(`-c.electronDist=${dist}`)
} else {
  console.warn(
    "[run-electron-builder] no local electron dist; electron-builder will fetch " +
      "via @electron/get (electronVersion + ELECTRON_MIRROR)."
  )
}
args.push(...process.argv.slice(2))

const result = spawnSync(process.execPath, [electronBuilderCli(), ...args], {
  env: childEnv,
  stdio: "inherit",
})
if (result.error) {
  console.error(`[run-electron-builder] spawn failed: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status == null ? 1 : result.status)
