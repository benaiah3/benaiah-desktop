import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Check, Loader2 } from '@/lib/icons'
import { notify, notifyError } from '@/store/notifications'

import { SettingsContent, SettingsSkeleton } from './primitives'

// Kept as a route enum so old `?pview=keys` and custom-endpoint bookmarks are
// safely coerced back to the only public inference account surface.
export const PROVIDER_VIEWS = ['accounts'] as const

export type ProviderView = (typeof PROVIDER_VIEWS)[number]

type AccountStatus = {
  email?: string
  linked: boolean
  pending?: boolean
}

export function ProvidersSettings({ onConfigSaved, onMainModelChanged }: ProvidersSettingsProps) {
  const [account, setAccount] = useState<AccountStatus | null>(null)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    let cancelled = false

    void window.hermesDesktop.benaiahAccount
      .status('default')
      .then(result => {
        if (!cancelled) {
          setAccount(result)
        }
      })
      .catch(error => {
        if (!cancelled) {
          notifyError(error, 'Could not read your Benaiah account')
          setAccount({ linked: false })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const connect = async () => {
    if (connecting) {
      return
    }

    setConnecting(true)

    try {
      await window.hermesDesktop.benaiahAccount.start()
      notify({
        durationMs: 8_000,
        kind: 'info',
        title: 'Complete sign-in in your browser',
        message: 'Benaiah will connect your plan, model catalogue and usage automatically.'
      })

      for (let attempt = 0; attempt < 150; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 2_000))
        const result = await window.hermesDesktop.benaiahAccount.status('default')

        if (!result.linked) {
          continue
        }

        setAccount(result)
        onConfigSaved?.()
        onMainModelChanged?.('custom', 'benaiah-auto')
        notify({
          durationMs: 4_000,
          kind: 'success',
          title: 'Benaiah account connected',
          message: 'Managed model routing is ready.'
        })

        return
      }

      throw new Error('Benaiah sign-in timed out. Try connecting again.')
    } catch (error) {
      notifyError(error, 'Could not connect your Benaiah account')
    } finally {
      setConnecting(false)
    }
  }

  if (!account) {
    return <SettingsSkeleton sections={[{ rows: 2 }]} />
  }

  return (
    <SettingsContent>
      <section className="grid gap-4">
        <div>
          <h2 className="text-[length:var(--conversation-text-font-size)] font-semibold">Benaiah account</h2>
          <p className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-5 text-(--ui-text-tertiary)">
            One account manages your plan, model routing, allowances and provider failover.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-foreground font-semibold text-background">
              B
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium">{account.linked ? account.email || 'Benaiah' : 'Connect Benaiah'}</p>
                {account.linked ? <Check className="size-4 shrink-0" /> : null}
              </div>
              <p className="text-xs text-(--ui-text-tertiary)">
                {account.linked ? 'Managed inference is active' : 'Sign in once—no provider keys required'}
              </p>
            </div>
          </div>

          {!account.linked ? (
            <Button disabled={connecting} onClick={() => void connect()} size="sm">
              {connecting ? <Loader2 className="animate-spin" /> : null}
              {connecting ? 'Connecting…' : 'Connect'}
            </Button>
          ) : null}
        </div>

        <p className="text-xs leading-5 text-(--ui-text-tertiary)">
          Model-provider credentials are managed securely by Benaiah. Keys for your tools, connectors, MCPs and business
          apps remain under your control.
        </p>
      </section>
    </SettingsContent>
  )
}

interface ProvidersSettingsProps {
  onConfigSaved?: () => void
  onMainModelChanged?: (provider: string, model: string) => void
}
