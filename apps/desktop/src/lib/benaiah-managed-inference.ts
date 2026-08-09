import { normalize } from '@/lib/text'
import type { HermesConfig, ModelInfoResponse, ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

export const BENAIAH_MANAGED_MODEL = 'benaiah-auto'
export const BENAIAH_MANAGED_PROVIDER = 'custom'

/**
 * Benaiah Auto's public ladder. The values are deliberately transport codes
 * understood by Hermes; the labels are the stable Benaiah product language.
 * Never expose Hermes' larger internal reasoning scale for this model.
 */
export const BENAIAH_AUTO_LEVELS = [
  { effort: 'ultra', label: 'Pro' },
  { effort: 'xhigh', label: 'Extra High' },
  { effort: 'high', label: 'High' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'minimal', label: 'Low' }
] as const

export const BENAIAH_AUTO_DEFAULT_EFFORT = 'high'
const BENAIAH_AUTO_LADDER_MIGRATION = 'benaiah-auto-ladder-v4'

const BENAIAH_AUTO_LABELS = new Map<string, string>(
  BENAIAH_AUTO_LEVELS.map(level => [level.effort, level.label])
)

export function isBenaiahAutoModel(model: string): boolean {
  return normalize(model) === BENAIAH_MANAGED_MODEL
}

/** Collapse stale Hermes-only values onto the closest public Auto tier. */
export function resolveBenaiahAutoEffort(effort: string, fallback = BENAIAH_AUTO_DEFAULT_EFFORT): string {
  const value = normalize(effort || fallback)

  if (BENAIAH_AUTO_LABELS.has(value)) {
    return value
  }

  if (value === 'max') {
    return 'xhigh'
  }

  if (value === 'none' || value === 'low') {
    return 'minimal'
  }

  return BENAIAH_AUTO_DEFAULT_EFFORT
}

export function benaiahAutoLevelLabel(effort: string, fallback = BENAIAH_AUTO_DEFAULT_EFFORT): string {
  return BENAIAH_AUTO_LABELS.get(resolveBenaiahAutoEffort(effort, fallback)) ?? 'High'
}

export function defaultEffortForModel(model: string, profileDefault: string): string {
  return isBenaiahAutoModel(model)
    ? resolveBenaiahAutoEffort(profileDefault, BENAIAH_AUTO_DEFAULT_EFFORT)
    : profileDefault
}

function autoMigrationKey(profile: string): string {
  return `${BENAIAH_AUTO_LADDER_MIGRATION}:${profile.trim() || 'default'}`
}

export function benaiahAutoDefaultMigrationPending(profile = 'default'): boolean {
  try {
    return window.localStorage.getItem(autoMigrationKey(profile)) !== '1'
  } catch {
    return true
  }
}

export function markBenaiahAutoDefaultMigrated(profile = 'default'): void {
  try {
    window.localStorage.setItem(autoMigrationKey(profile), '1')
  } catch {
    // Config persistence remains authoritative when local storage is blocked.
  }
}

/**
 * The former Desktop inherited Hermes' `medium` default, which appeared as
 * "Benaiah Auto Med". On the first five-tier build, migrate that exact stale
 * default to Benaiah High. Other explicit values remain user-owned.
 */
export function withBenaiahAutoDefault(config: HermesConfig, profile = 'default'): {
  changed: boolean
  config: HermesConfig
  migrationPending: boolean
} {
  const migrationPending = benaiahAutoDefaultMigrationPending(profile)
  const configuredEffort = normalize(config.agent?.reasoning_effort ?? '')
  const migrateEffort = migrationPending && (!configuredEffort || configuredEffort === 'medium')
  let transportChanged = false
  const customProviders = config.custom_providers?.map(provider => {
    if (!BENAIAH_GATEWAY_RE.test(String(provider.base_url || ''))) {
      return provider
    }

    if (provider.extra_body?.benaiah_auto_ladder === 'v1') {
      return provider
    }

    transportChanged = true
    return {
      ...provider,
      extra_body: {
        ...provider.extra_body,
        benaiah_auto_ladder: 'v1'
      }
    }
  })

  if (!migrateEffort && !transportChanged) {
    return { changed: false, config, migrationPending }
  }

  return {
    changed: true,
    migrationPending,
    config: {
      ...config,
      ...(migrateEffort
        ? {
            agent: {
              ...config.agent,
              reasoning_effort: BENAIAH_AUTO_DEFAULT_EFFORT
            }
          }
        : {}),
      ...(customProviders ? { custom_providers: customProviders } : {})
    }
  }
}

const BENAIAH_GATEWAY_RE = /benaiah(?:-cli-gateway[^/]*)?(?:\.ai|\.vercel\.app)/i

function isManagedRow(provider: ModelOptionProvider): boolean {
  return (
    provider.models?.includes(BENAIAH_MANAGED_MODEL) === true ||
    (provider.slug === BENAIAH_MANAGED_PROVIDER && BENAIAH_GATEWAY_RE.test(provider.api_url ?? ''))
  )
}

export function benaiahManagedModelOptions(response: ModelOptionsResponse): ModelOptionsResponse {
  const existing = response.providers?.find(isManagedRow)

  // Benaiah owns the gateway, billing and credentials — it does not collapse
  // the user's model choice. Preserve the gateway's live curated catalogue and
  // hide only provider rows that would require a separate subscription or key.
  const models = [...new Set((existing?.models ?? []).filter(Boolean))]

  if (models.length === 0) {
    models.push(BENAIAH_MANAGED_MODEL)
  }

  const selectedModel =
    response.model && models.includes(response.model)
      ? response.model
      : models.includes(BENAIAH_MANAGED_MODEL)
        ? BENAIAH_MANAGED_MODEL
        : models[0]

  const managed: ModelOptionProvider = existing
    ? {
        ...existing,
        authenticated: true,
        // Every gateway model has already passed Benaiah's curation boundary.
        // Expose the full shortlist by default rather than applying a second,
        // narrower featured filter in the desktop picker.
        featured_models: models,
        is_current: true,
        models,
        name: 'Benaiah',
        slug: BENAIAH_MANAGED_PROVIDER,
        total_models: models.length
      }
    : {
        authenticated: true,
        featured_models: [BENAIAH_MANAGED_MODEL],
        is_current: true,
        models: [BENAIAH_MANAGED_MODEL],
        name: 'Benaiah',
        slug: BENAIAH_MANAGED_PROVIDER,
        total_models: 1
      }

  return {
    ...response,
    model: selectedModel,
    provider: BENAIAH_MANAGED_PROVIDER,
    providers: [managed]
  }
}

export function benaiahManagedModelInfo(response: ModelInfoResponse): ModelInfoResponse {
  return {
    ...response,
    model:
      response.provider === BENAIAH_MANAGED_PROVIDER && response.model
        ? response.model
        : BENAIAH_MANAGED_MODEL,
    provider: BENAIAH_MANAGED_PROVIDER
  }
}
