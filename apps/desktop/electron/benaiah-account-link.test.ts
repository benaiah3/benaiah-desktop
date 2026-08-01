import { describe, expect, it } from 'vitest'

import { prepareBenaiahAccountLink } from './benaiah-account-link'

describe('prepareBenaiahAccountLink', () => {
  it('carries a one-time account link directly into the matching remote Mac', () => {
    const value = prepareBenaiahAccountLink('https://benaiah.ai/settings?code=one-time-code#profile', {
      deviceId: 'device_1234567890',
      returnToRemote: true
    })

    const url = new URL(value)

    expect(url.origin).toBe('https://benaiah.ai')
    expect(url.pathname).toBe('/settings')
    expect(url.searchParams.get('code')).toBe('one-time-code')
    expect(url.searchParams.get('next')).toBe('remote')
    expect(url.searchParams.get('device')).toBe('device_1234567890')
    expect(url.hash).toBe('#profile')
  })

  it('rejects an account link outside Benaiah', () => {
    expect(() => prepareBenaiahAccountLink('https://example.com/settings?code=one-time-code#profile')).toThrow(
      /valid account link/i
    )
  })
})
