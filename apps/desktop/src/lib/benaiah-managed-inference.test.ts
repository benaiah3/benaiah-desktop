import { describe, expect, it } from 'vitest'

import {
  BENAIAH_MANAGED_MODEL,
  BENAIAH_MANAGED_PROVIDER,
  benaiahAutoLevelLabel,
  benaiahManagedModelInfo,
  benaiahManagedModelOptions,
  defaultEffortForModel,
  resolveBenaiahAutoEffort
} from './benaiah-managed-inference'

describe('Benaiah managed inference policy', () => {
  it('keeps the public Auto ladder separate from Hermes reasoning terminology', () => {
    expect(resolveBenaiahAutoEffort('max')).toBe('xhigh')
    expect(resolveBenaiahAutoEffort('low')).toBe('minimal')
    expect(benaiahAutoLevelLabel('max')).toBe('Extra High')
    expect(benaiahAutoLevelLabel('none')).toBe('Low')
    expect(defaultEffortForModel(BENAIAH_MANAGED_MODEL, '')).toBe('high')
    expect(defaultEffortForModel('openai/gpt-5.6-sol', 'medium')).toBe('medium')
  })

  it('hides direct providers and preserves the live Benaiah catalogue', () => {
    const result = benaiahManagedModelOptions({
      model: 'gpt-5.6-sol',
      provider: 'custom',
      providers: [
        { authenticated: true, models: ['claude-opus-4'], name: 'Anthropic', slug: 'anthropic' },
        {
          api_url: 'https://benaiah.ai/api/cli/v1',
          authenticated: true,
          models: ['benaiah-auto', 'gpt-5.6-sol', 'deepseek-v4-flash'],
          name: 'Custom',
          slug: 'custom'
        }
      ]
    })

    expect(result.provider).toBe(BENAIAH_MANAGED_PROVIDER)
    expect(result.model).toBe('gpt-5.6-sol')
    expect(result.providers).toHaveLength(1)
    expect(result.providers?.[0]).toMatchObject({
      featured_models: ['benaiah-auto', 'gpt-5.6-sol', 'deepseek-v4-flash'],
      models: ['benaiah-auto', 'gpt-5.6-sol', 'deepseek-v4-flash'],
      name: 'Benaiah',
      total_models: 3
    })
  })

  it('creates the managed row while the account is awaiting activation', () => {
    const result = benaiahManagedModelOptions({ providers: [] })

    expect(result.providers).toEqual([
      expect.objectContaining({
        authenticated: true,
        models: [BENAIAH_MANAGED_MODEL],
        name: 'Benaiah',
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

  it('preserves a model already routed through Benaiah', () => {
    expect(benaiahManagedModelInfo({ model: 'deepseek-v4-flash', provider: 'custom' })).toEqual({
      model: 'deepseek-v4-flash',
      provider: BENAIAH_MANAGED_PROVIDER
    })
  })
})
