import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { createReleaseUpdaterController, mapReleaseUpdateStatus, type ReleaseUpdaterLike } from './release-updater'

class FakeUpdater extends EventEmitter implements ReleaseUpdaterLike {
  allowDowngrade = true
  allowPrerelease = true
  autoDownload = true
  autoInstallOnAppQuit = false
  autoRunAppAfterInstall = false
  disableWebInstaller = false
  fullChangelog = true
  setFeedURL = vi.fn()
  checkForUpdates = vi.fn()
  downloadUpdate = vi.fn()
  quitAndInstall = vi.fn()
}

function updateResult(version: string, available = true) {
  return {
    isUpdateAvailable: available,
    updateInfo: {
      files: [],
      path: '',
      releaseDate: '2026-07-29T10:00:00.000Z',
      releaseName: `Benaiah ${version}`,
      releaseNotes: 'A reviewed Benaiah release.',
      sha512: '',
      version
    },
    versionInfo: {} as never
  }
}

describe('release updater', () => {
  it('maps the signed release result into stable app status', () => {
    expect(mapReleaseUpdateStatus('0.20.1', updateResult('0.21.0'))).toEqual({
      currentVersion: '0.20.1',
      latestVersion: '0.21.0',
      releaseDate: '2026-07-29T10:00:00.000Z',
      releaseName: 'Benaiah 0.21.0',
      releaseNotes: 'A reviewed Benaiah release.',
      updateAvailable: true
    })
  })

  it('checks without downloading, then downloads and installs only on user action', async () => {
    const updater = new FakeUpdater()
    const result = updateResult('0.21.0')
    updater.checkForUpdates.mockResolvedValue(result)
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', { percent: 42, transferred: 42, total: 100 })
      updater.emit('update-downloaded', result.updateInfo)

      return ['/tmp/Benaiah.zip']
    })

    const emitProgress = vi.fn()
    const controller = createReleaseUpdaterController({
      currentVersion: () => '0.20.1',
      emitProgress,
      log: vi.fn(),
      updater
    })

    expect(updater.autoDownload).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.disableWebInstaller).toBe(true)
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      owner: 'benaiah3',
      provider: 'github',
      releaseType: 'release',
      repo: 'benaiah-desktop'
    })

    await expect(controller.check()).resolves.toMatchObject({
      latestVersion: '0.21.0',
      updateAvailable: true
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    await controller.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(emitProgress).toHaveBeenCalledWith({ percent: 42, transferred: 42, total: 100 })

    controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})
