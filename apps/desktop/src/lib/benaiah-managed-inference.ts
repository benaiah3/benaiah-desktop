import type { ModelInfoResponse, ModelOptionProvider, ModelOptionsResponse } from '@/types/hermes'

export const BENAIAH_MANAGED_MODEL = 'benaiah-auto'
export const BENAIAH_MANAGED_PROVIDER = 'custom'

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
