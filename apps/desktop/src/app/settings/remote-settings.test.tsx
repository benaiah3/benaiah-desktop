import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createPairing = vi.fn()
const startAccount = vi.fn()
const startAccountQr = vi.fn()
const accountStatus = vi.fn()
const toDataURL = vi.fn()

vi.mock('qrcode', () => ({
  default: {
    toDataURL: (url: string) => toDataURL(url)
  }
}))

beforeEach(() => {
  createPairing.mockResolvedValue({
    linked: false,
    online: false,
    state: 'signed-out'
  })
  startAccountQr.mockResolvedValue({
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    linked: false,
    linkUrl: 'https://benaiah.ai/settings?code=secure&next=remote&device=device_1234567890#profile',
    opened: false
  })
  accountStatus.mockResolvedValue({ linked: false, pending: true })
  toDataURL.mockResolvedValue('data:image/png;base64,phone-qr')

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      benaiahAccount: {
        start: startAccount,
        startQr: startAccountQr,
        status: accountStatus,
        reopen: vi.fn()
      },
      benaiahRemote: {
        createPairing
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RemoteSettings', () => {
  it('keeps account connection inside Desktop and renders a phone QR', async () => {
    const { RemoteSettings } = await import('./remote-settings')
    render(<RemoteSettings />)

    fireEvent.click(await screen.findByRole('button', { name: /connect account/i }))

    await waitFor(() => expect(startAccountQr).toHaveBeenCalledTimes(1))
    expect(startAccount).not.toHaveBeenCalled()
    expect(
      (await screen.findByAltText('Scan to connect this Mac to your Benaiah account')).getAttribute('src')
    ).toBe('data:image/png;base64,phone-qr')
    expect(screen.getByText('Scan with the phone you use for Benaiah')).toBeTruthy()
  })
})
