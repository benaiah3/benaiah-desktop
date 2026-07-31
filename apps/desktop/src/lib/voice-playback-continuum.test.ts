import { afterEach, describe, expect, it } from 'vitest'

import { consumeUserStopRequested, stopVoicePlayback } from './voice-playback'

describe('voice playback continuum stop latch', () => {
  afterEach(() => {
    // Drain any latch left by a test so later suites stay clean.
    consumeUserStopRequested()
    stopVoicePlayback()
    consumeUserStopRequested()
  })

  it('does not treat internal stopVoicePlayback as a user stop', () => {
    stopVoicePlayback()
    expect(consumeUserStopRequested()).toBe(false)
  })

  it('latches an explicit user-initiated stop for continuum settle', () => {
    stopVoicePlayback({ userInitiated: true })
    expect(consumeUserStopRequested()).toBe(true)
    // One-shot: second consume is clear.
    expect(consumeUserStopRequested()).toBe(false)
  })

  it('lets Edge-style internal handoffs re-listen after speech', () => {
    // Mimic openLiveSpeech + Edge fallback: stream open stop, then POST play stop.
    consumeUserStopRequested()
    stopVoicePlayback()
    stopVoicePlayback()
    const stoppedByUser = consumeUserStopRequested()
    expect(stoppedByUser).toBe(false)
    const pendingStart = !stoppedByUser
    expect(pendingStart).toBe(true)
  })
})
