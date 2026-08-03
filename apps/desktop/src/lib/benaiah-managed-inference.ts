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

  const managed: ModelOptionProvider = existing
    ? {
        ...existing,
        authenticated: true,
        featured_models: [BENAIAH_MANAGED_MODEL],
        is_current: true,
        models: [BENAIAH_MANAGED_MODEL],
        name: 'Benaiah Auto',
        slug: BENAIAH_MANAGED_PROVIDER,
        total_models: 1
      }
    : {
        authenticated: true,
        featured_models: [BENAIAH_MANAGED_MODEL],
        is_current: true,
        models: [BENAIAH_MANAGED_MODEL],
        name: 'Benaiah Auto',
        slug: BENAIAH_MANAGED_PROVIDER,
        total_models: 1
      }

  return {
    ...response,
    model: BENAIAH_MANAGED_MODEL,
    provider: BENAIAH_MANAGED_PROVIDER,
    providers: [managed]
  }
}

export function benaiahManagedModelInfo(response: ModelInfoResponse): ModelInfoResponse {
  return {
    ...response,
    model: BENAIAH_MANAGED_MODEL,
    provider: BENAIAH_MANAGED_PROVIDER
  }
}
