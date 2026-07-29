import { describe, expect, it } from 'vitest'

import { BENAIAH_EDGE_VOICE, withBenaiahVoiceDefaults } from './benaiah-voice-defaults'

describe('withBenaiahVoiceDefaults', () => {
  it('sets Ryan for a profile inheriting the free Edge default', () => {
    const result = withBenaiahVoiceDefaults({ voice: { auto_tts: true } })

    expect(result.changed).toBe(true)
    expect(result.config.tts?.edge?.voice).toBe(BENAIAH_EDGE_VOICE)
  })

  it('migrates the former Aria default to Ryan', () => {
    const result = withBenaiahVoiceDefaults({
      tts: { provider: 'edge', edge: { voice: 'en-US-AriaNeural' } }
    })

    expect(result.changed).toBe(true)
    expect(result.config.tts?.edge?.voice).toBe(BENAIAH_EDGE_VOICE)
  })

  it('preserves an explicit Edge voice choice', () => {
    const config = { tts: { provider: 'edge', edge: { voice: 'en-GB-ThomasNeural' } } }
    const result = withBenaiahVoiceDefaults(config)

    expect(result).toEqual({ changed: false, config })
  })

  it('does not alter a paid or local speech provider', () => {
    const config = { tts: { provider: 'openai' } }
    const result = withBenaiahVoiceDefaults(config)

    expect(result).toEqual({ changed: false, config })
  })
})
