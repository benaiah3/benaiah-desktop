import { describe, expect, it } from 'vitest'

import {
  benaiahBrowserLinkCode,
  benaiahBrowserLinkPrompt,
  prepareBenaiahAccountLink
} from './benaiah-account-link'

describe('prepareBenaiahAccountLink', () => {
  it('carries a one-time account link directly into the matching remote computer', () => {
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

describe('benaiahBrowserLinkCode', () => {
  it('accepts only the signed one-time browser handoff owned by Benaiah Work', () => {
    expect(benaiahBrowserLinkCode('benaiah://browser-link?code=payload.signature')).toBe('payload.signature')
    expect(benaiahBrowserLinkCode('hermes://browser-link?code=payload.signature')).toBeNull()
    expect(benaiahBrowserLinkCode('benaiah://chat?code=payload.signature')).toBeNull()
    expect(benaiahBrowserLinkCode('benaiah://browser-link?code=not-signed')).toBeNull()
  })

  it('makes the account boundary explicit before Work authorises Chrome', () => {
    expect(benaiahBrowserLinkPrompt('person@example.com')).toEqual({
      message: 'Connect Benaiah for Chrome?',
      detail:
        'Allow this Chrome profile to use person@example.com for See, Chat and Work. Your Benaiah Work credential is never shared.'
    })
  })
})
