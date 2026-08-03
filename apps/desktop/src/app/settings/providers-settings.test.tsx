import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accountStart = vi.fn()
const accountStatus = vi.fn()

beforeEach(() => {
  accountStart.mockResolvedValue({ opened: true })
  accountStatus.mockResolvedValue({ email: 'member@benaiah.ai', linked: true, pending: false })

  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      benaiahAccount: {
        start: accountStart,
        status: accountStatus
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('ProvidersSettings', () => {
  it('shows only the managed Benaiah account surface', async () => {
    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings />)

    expect(await screen.findByText('member@benaiah.ai')).toBeTruthy()
    expect(screen.getByText('Managed inference is active')).toBeTruthy()
    expect(screen.getByText(/tool and connector credentials were preserved|tools, connectors, MCPs/)).toBeTruthy()
    expect(screen.queryByText(/API key/i)).toBeNull()
    expect(screen.queryByText(/custom endpoint/i)).toBeNull()
  })

  it('routes a signed-out user into Benaiah sign-in', async () => {
    accountStatus.mockResolvedValue({ linked: false, pending: false })
    accountStart.mockRejectedValueOnce(new Error('test stop'))

    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(accountStart).toHaveBeenCalledOnce())
  })
})
