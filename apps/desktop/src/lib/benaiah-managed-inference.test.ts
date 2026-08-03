import { describe, expect, it } from 'vitest'

import {
  BENAIAH_MANAGED_MODEL,
  BENAIAH_MANAGED_PROVIDER,
  benaiahManagedModelInfo,
  benaiahManagedModelOptions
} from './benaiah-managed-inference'

describe('Benaiah managed inference policy', () => {
  it('exposes only the managed route even when direct providers are configured', () => {
    const result = benaiahManagedModelOptions({
      model: 'claude-opus-4',
      provider: 'anthropic',
      providers: [
        { authenticated: true, models: ['claude-opus-4'], name: 'Anthropic', slug: 'anthropic' },
        {
          api_url: 'https://benaiah.ai/api/cli/v1',
          authenticated: true,
          models: ['benaiah-auto', 'legacy-direct-model'],
          name: 'Custom',
          slug: 'custom'
        }
      ]
    })

    expect(result.provider).toBe(BENAIAH_MANAGED_PROVIDER)
    expect(result.model).toBe(BENAIAH_MANAGED_MODEL)
    expect(result.providers).toHaveLength(1)
    expect(result.providers?.[0].models).toEqual([BENAIAH_MANAGED_MODEL])
  })

  it('creates the managed row while the account is awaiting activation', () => {
    const result = benaiahManagedModelOptions({ providers: [] })

    expect(result.providers).toEqual([
      expect.objectContaining({
        authenticated: true,
        models: [BENAIAH_MANAGED_MODEL],
        name: 'Benaiah Auto',
        slug: BENAIAH_MANAGED_PROVIDER
      })
    ])
  })

  it('normalizes stale model info from an earlier BYOK installation', () => {
    expect(benaiahManagedModelInfo({ model: 'gpt-5', provider: 'openai' })).toEqual({
      model: BENAIAH_MANAGED_MODEL,
      provider: BENAIAH_MANAGED_PROVIDER
    })
  })
})
