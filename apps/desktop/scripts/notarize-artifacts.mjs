import { execFile } from "node:child_process"
import path from "node:path"

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed: ${
              stderr?.trim() || stdout?.trim() || error.message
            }`
          )
        )
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export default async function notarizeArtifacts(context) {
  if (process.platform !== "darwin") return context.artifactPaths

  const profile = String(process.env.APPLE_NOTARY_PROFILE || "").trim()
  if (!profile) {
    console.log(
      "Skipping disk-image notarization: APPLE_NOTARY_PROFILE is not configured."
    )
    return context.artifactPaths
  }

  const keychain = String(process.env.APPLE_NOTARY_KEYCHAIN || "").trim()
  const credentials = ["--keychain-profile", profile]
  if (keychain) credentials.push("--keychain", keychain)

  const diskImages = context.artifactPaths.filter(
    (artifactPath) => path.extname(artifactPath).toLowerCase() === ".dmg"
  )

  for (const diskImage of diskImages) {
    await run("codesign", ["--verify", "--verbose=2", diskImage])
    await run("xcrun", [
      "notarytool",
      "submit",
      diskImage,
      ...credentials,
      "--wait",
    ])
    await run("xcrun", ["stapler", "staple", "-v", diskImage])
    await run("xcrun", ["stapler", "validate", diskImage])
    await run("spctl", [
      "-a",
      "-vv",
      "-t",
      "open",
      "--context",
      "context:primary-signature",
      diskImage,
    ])
  }

  return context.artifactPaths
}
