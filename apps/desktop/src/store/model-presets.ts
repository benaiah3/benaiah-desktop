import { atom } from 'nanostores'

import { BENAIAH_AUTO_DEFAULT_EFFORT, BENAIAH_MANAGED_MODEL, BENAIAH_MANAGED_PROVIDER } from '@/lib/benaiah-managed-inference'
import { persistString, storedString } from '@/lib/storage'

import { notifyError } from './notifications'
import { setCurrentFastMode, setCurrentReasoningEffort } from './session'
import { sessionTileDelegate } from './session-states'

const STORAGE_KEY = 'hermes.desktop.model-presets'
const BENAIAH_AUTO_PRESET_MIGRATION_KEY = 'benaiah-auto-preset-v1'

/** Per-model reasoning/fast preset, remembered globally across sessions and
 *  re-applied to the session whenever that model is selected. Unset dimensions
 *  fall back to the Hermes default (medium effort, no fast). */
export interface ModelPreset {
  /** Set only by the five-tier Benaiah Auto selector. Distinguishes an
   *  intentional new Medium choice from Hermes' former medium default. */
  autoTier?: boolean
  effort?: string
  fast?: boolean
}

type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

/** Stable `provider::model` key (matches the visibility-store format). */
export const modelPresetKey = (provider: string, model: string): string => `${provider}::${model}`

function load(): Record<string, ModelPreset> {
  const raw = storedString(STORAGE_KEY)

  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      try {
        if (window.localStorage.getItem(BENAIAH_AUTO_PRESET_MIGRATION_KEY) !== '1') {
          const key = modelPresetKey(BENAIAH_MANAGED_PROVIDER, BENAIAH_MANAGED_MODEL)
          const preset = parsed[key] as ModelPreset | undefined

          if (preset?.effort === 'medium') {
            parsed[key] = { ...preset, autoTier: false, effort: BENAIAH_AUTO_DEFAULT_EFFORT }
            persistString(STORAGE_KEY, JSON.stringify(parsed))
          }

          window.localStorage.setItem(BENAIAH_AUTO_PRESET_MIGRATION_KEY, '1')
        }
      } catch {
        // Storage can be unavailable in hardened renderer contexts.
      }
    }

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, ModelPreset>) : {}
  } catch {
    return {}
  }
}

export const $modelPresets = atom<Record<string, ModelPreset>>(load())

export function getModelPreset(provider: string, model: string): ModelPreset {
  return $modelPresets.get()[modelPresetKey(provider, model)] ?? {}
}

/** Merge a partial preset for one model and persist. */
export function setModelPreset(provider: string, model: string, patch: ModelPreset): void {
  const key = modelPresetKey(provider, model)
  const next = { ...$modelPresets.get(), [key]: { ...$modelPresets.get()[key], ...patch } }

  $modelPresets.set(next)
  persistString(STORAGE_KEY, JSON.stringify(next))
}

/** Apply a model's preset to the composer, then push it to a live session.
 *  `undefined` skips that dimension; values are capability-gated upstream.
 *  Without a session the local draft still needs the preset, but must not call
 *  `config.set`: that falls back to persistent profile config when no session
 *  matches and would rewrite the user's defaults.
 *
 *  `primary: false` scopes the optimistic write to the tile's session slice —
 *  a tile's picker must not clobber the primary composer's effort/fast. */
export async function applyModelPreset(
  { effort, fast }: ModelPreset,
  ctx: { failMessage: string; primary?: boolean; request: RequestGateway; sessionId: null | string }
): Promise<void> {
  if (ctx.primary ?? true) {
    if (effort !== undefined) {
      setCurrentReasoningEffort(effort)
    }

    if (fast !== undefined) {
      setCurrentFastMode(fast)
    }
  } else if (ctx.sessionId) {
    sessionTileDelegate()?.updateSession(ctx.sessionId, state => ({
      ...state,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      ...(fast !== undefined ? { fast } : {})
    }))
  }

  if (!ctx.sessionId) {
    return
  }

  try {
    if (effort !== undefined) {
      await ctx.request('config.set', { key: 'reasoning', session_id: ctx.sessionId, value: effort })
    }

    if (fast !== undefined) {
      await ctx.request('config.set', { key: 'fast', session_id: ctx.sessionId, value: fast ? 'fast' : 'normal' })
    }
  } catch (err) {
    notifyError(err, ctx.failMessage)
  }
}
