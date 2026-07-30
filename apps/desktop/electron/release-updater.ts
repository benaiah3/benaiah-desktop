import type { ProgressInfo, UpdateCheckResult, UpdateInfo } from 'electron-updater'

export interface ReleaseUpdaterLike {
  allowDowngrade: boolean
  allowPrerelease: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  disableWebInstaller: boolean
  fullChangelog: boolean
  setFeedURL(options: {
    owner: string
    provider: 'github'
    releaseType: 'release'
    repo: string
  }): void
  checkForUpdates(): Promise<UpdateCheckResult | null>
  downloadUpdate(): Promise<string[]>
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'update-downloaded', listener: (info: UpdateInfo) => void): this
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface ReleaseUpdateStatus {
  currentVersion: string
  latestVersion: string
  releaseDate?: string
  releaseName?: string | null
  releaseNotes?: string | null
  updateAvailable: boolean
}

export interface ReleaseUpdateProgress {
  percent: number | null
  transferred?: number
  total?: number
}

export interface ReleaseUpdaterControllerOptions {
  currentVersion: () => string
  emitProgress: (progress: ReleaseUpdateProgress) => void
  log: (message: string) => void
  updater: ReleaseUpdaterLike
}

function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string | null {
  if (typeof notes === 'string') {
    return notes.trim() || null
  }

  if (!Array.isArray(notes)) {
    return null
  }

  const joined = notes
    .map(note => (typeof note === 'string' ? note : note?.note))
    .filter((note): note is string => Boolean(note?.trim()))
    .join('\n\n')

  return joined.trim() || null
}

export function mapReleaseUpdateStatus(
  currentVersion: string,
  result: UpdateCheckResult | null
): ReleaseUpdateStatus {
  const info = result?.updateInfo

  return {
    currentVersion,
    latestVersion: info?.version || currentVersion,
    releaseDate: info?.releaseDate,
    releaseName: info?.releaseName ?? null,
    releaseNotes: normalizeReleaseNotes(info?.releaseNotes),
    updateAvailable: Boolean(result?.isUpdateAvailable)
  }
}

export function createReleaseUpdaterController({
  currentVersion,
  emitProgress,
  log,
  updater
}: ReleaseUpdaterControllerOptions) {
  // Set the reviewed Benaiah release feed in code as well as packaging it in
  // app-update.yml. This keeps update discovery self-healing if an internally
  // staged app bundle is installed without electron-builder's generated file.
  updater.setFeedURL({
    owner: 'benaiah3',
    provider: 'github',
    releaseType: 'release',
    repo: 'benaiah-desktop'
  })
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true
  updater.autoRunAppAfterInstall = true
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.fullChangelog = false
  updater.disableWebInstaller = true

  let lastCheck: UpdateCheckResult | null = null
  let checkInFlight: Promise<ReleaseUpdateStatus> | null = null
  let downloadInFlight: Promise<string[]> | null = null
  let downloadedVersion: string | null = null
  let applying = false

  updater.on('download-progress', progress => {
    if (!applying) {
      return
    }

    emitProgress({
      percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : null,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  updater.on('update-downloaded', info => {
    downloadedVersion = info.version
    log(`[release-updater] downloaded Benaiah ${info.version}`)
  })

  updater.on('error', error => {
    log(`[release-updater] ${error.message || String(error)}`)
  })

  async function check(): Promise<ReleaseUpdateStatus> {
    if (checkInFlight) {
      return checkInFlight
    }

    checkInFlight = updater
      .checkForUpdates()
      .then(result => {
        lastCheck = result
        const status = mapReleaseUpdateStatus(currentVersion(), result)
        log(
          status.updateAvailable
            ? `[release-updater] Benaiah ${status.latestVersion} is available`
            : `[release-updater] Benaiah ${status.currentVersion} is current`
        )

        return status
      })
      .finally(() => {
        checkInFlight = null
      })

    return checkInFlight
  }

  async function download(): Promise<ReleaseUpdateStatus> {
    const status =
      lastCheck?.isUpdateAvailable && lastCheck.updateInfo.version
        ? mapReleaseUpdateStatus(currentVersion(), lastCheck)
        : await check()

    if (!status.updateAvailable) {
      return status
    }

    applying = true

    try {
      if (downloadedVersion !== status.latestVersion) {
        downloadInFlight ??= updater.downloadUpdate()

        try {
          await downloadInFlight
        } finally {
          downloadInFlight = null
        }
      }

      return status
    } finally {
      applying = false
    }
  }

  function install(): void {
    updater.quitAndInstall(false, true)
  }

  return { check, download, install }
}
