import type { HermesConfig } from '@/types/hermes'

export const BENAIAH_EDGE_VOICE = 'en-GB-RyanNeural'

const LEGACY_BENAIAH_EDGE_VOICES = new Set(['', 'en-US-AriaNeural'])

/**
 * Move profiles that still inherit Benaiah's former Aria default onto Ryan.
 * Explicit provider and voice choices remain authoritative.
 */
export function withBenaiahVoiceDefaults(config: HermesConfig): {
  changed: boolean
  config: HermesConfig
} {
  const provider = config.tts?.provider?.trim().toLowerCase()

  if (provider && provider !== 'edge') {
    return { changed: false, config }
  }

  const voice = config.tts?.edge?.voice?.trim() ?? ''

  if (!LEGACY_BENAIAH_EDGE_VOICES.has(voice)) {
    return { changed: false, config }
  }

  return {
    changed: true,
    config: {
      ...config,
      tts: {
        ...config.tts,
        edge: {
          ...config.tts?.edge,
          voice: BENAIAH_EDGE_VOICE
        }
      }
    }
  }
}
