import { describe, expect, it } from 'vitest'

import type { EnvVarInfo } from '@/types/hermes'

import { isLegacyModelProviderCredential } from './benaiah-managed-inference'

const credential = (category: string, isSet = true): EnvVarInfo =>
  ({ category, is_set: isSet }) as EnvVarInfo

describe('legacy model-provider credential boundary', () => {
  it('selects configured model-provider keys', () => {
    expect(isLegacyModelProviderCredential(credential('provider'))).toBe(true)
  })

  it.each(['tool', 'messaging', 'memory', 'setting'])('preserves %s credentials', category => {
    expect(isLegacyModelProviderCredential(credential(category))).toBe(false)
  })

  it('ignores empty provider rows', () => {
    expect(isLegacyModelProviderCredential(credential('provider', false))).toBe(false)
  })
})
