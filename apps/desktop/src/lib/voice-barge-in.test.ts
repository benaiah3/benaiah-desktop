import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { monitorSpeechDuringPlayback } from './voice-barge-in'

let inputLevel = 0

class FakeAnalyser {
  fftSize = 256

  getByteTimeDomainData(data: Uint8Array) {
    data.fill(128 + Math.round(inputLevel * 42))
  }
}

class FakeAudioContext {
  createAnalyser() {
    return new FakeAnalyser()
  }

  createMediaStreamSource() {
    return { connect: vi.fn() }
  }

  close() {
    return Promise.resolve()
  }
}

describe('voice barge-in phase calibration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    inputLevel = 0
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('MediaRecorder', undefined)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 16)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle))
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }))
      }
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not lock a zero floor or trip on ambient noise across a preparation gap', async () => {
    let appAudioActive = true
    const onSpeech = vi.fn()
    const stop = monitorSpeechDuringPlayback({ isPlaying: () => appAudioActive, onSpeech })

    await Promise.resolve()
    inputLevel = 0.1
    await vi.advanceTimersByTimeAsync(650)
    expect(onSpeech).not.toHaveBeenCalled()

    // Simulate thinking sound ending just before TTS reports playback. This
    // used to expose the normal 0.075 threshold with an empty/zero floor.
    appAudioActive = false
    await vi.advanceTimersByTimeAsync(350)
    expect(onSpeech).not.toHaveBeenCalled()

    stop()
  })

  it('still detects intentional nearby speech during protected app audio', async () => {
    const onSpeech = vi.fn()
    const stop = monitorSpeechDuringPlayback({ isPlaying: () => true, onSpeech })

    await Promise.resolve()
    inputLevel = 0.25
    await vi.advanceTimersByTimeAsync(900)

    expect(onSpeech).toHaveBeenCalledTimes(1)
    stop()
  })

  it('uses a measured quiet floor for normal non-playback speech detection', async () => {
    const onSpeech = vi.fn()
    const stop = monitorSpeechDuringPlayback({ isPlaying: () => false, onSpeech })

    await Promise.resolve()
    inputLevel = 0.02
    await vi.advanceTimersByTimeAsync(500)
    inputLevel = 0.1
    await vi.advanceTimersByTimeAsync(400)

    expect(onSpeech).toHaveBeenCalledTimes(1)
    stop()
  })
})
