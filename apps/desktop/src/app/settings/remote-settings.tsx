import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { CheckCircle2, QrCode, RefreshCw } from '@/lib/icons'

import { SettingsContent } from './primitives'

type Pairing = Awaited<ReturnType<typeof window.hermesDesktop.benaiahRemote.createPairing>>
type AccountLink = Awaited<ReturnType<typeof window.hermesDesktop.benaiahAccount.startQr>>

const SECURE_CODE_ERROR = 'Benaiah could not create a secure connection code. Check your connection and try again.'

async function qrDataUrl(url: string) {
  return QRCode.toDataURL(url, {
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 440
  })
}

function remainingLabel(expiresAt?: string) {
  const remaining = Math.max(0, new Date(expiresAt || '').getTime() - Date.now())
  const seconds = Math.ceil(remaining / 1000)
  const minutes = Math.floor(seconds / 60)
  return seconds > 0 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : 'Expired'
}

export function RemoteSettings() {
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [qrCode, setQrCode] = useState('')
  const [accountLink, setAccountLink] = useState<AccountLink | null>(null)
  const [accountQrCode, setAccountQrCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [connectingAccount, setConnectingAccount] = useState(false)
  const [, tick] = useState(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const next = await window.hermesDesktop.benaiahRemote.createPairing()
      setPairing(next)
      if (next.url) {
        setQrCode(await qrDataUrl(next.url))
      } else {
        setQrCode('')
      }
    } catch {
      setPairing(null)
      setQrCode('')
      setError(SECURE_CODE_ERROR)
    } finally {
      setLoading(false)
    }
  }, [])

  const connectAccount = useCallback(async () => {
    setConnectingAccount(true)
    setError('')
    try {
      const next = await window.hermesDesktop.benaiahAccount.startQr()
      if (!next.linkUrl) {
        throw new Error('Benaiah did not return a phone connection code.')
      }
      setAccountLink(next)
      setAccountQrCode(await qrDataUrl(next.linkUrl))
    } catch {
      setAccountLink(null)
      setAccountQrCode('')
      setError(SECURE_CODE_ERROR)
    } finally {
      setConnectingAccount(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const timer = window.setInterval(() => tick(value => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!accountLink) return

    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const status = await window.hermesDesktop.benaiahAccount.status('default')
        if (status.linked) {
          setAccountLink(null)
          setAccountQrCode('')
          await refresh()
        }
      } catch {
        // Keep the QR visible. A transient poll failure should not interrupt pairing.
      } finally {
        checking = false
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 1500)
    return () => window.clearInterval(timer)
  }, [accountLink, refresh])

  const expired = Boolean(pairing?.expiresAt && new Date(pairing.expiresAt).getTime() <= Date.now())
  const accountExpired = Boolean(
    accountLink?.expiresAt && new Date(accountLink.expiresAt).getTime() <= Date.now()
  )

  return (
    <SettingsContent>
      <div className="mx-auto w-full max-w-xl pt-8 pb-12">
        <div className="text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-2xl border border-border/70 bg-muted/20">
            <QrCode className="size-6" />
          </div>
          <h2 className="mt-4 text-xl font-semibold tracking-tight">Remote</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
            Scan once to take Benaiah with you.
          </p>
        </div>

        <div className="mt-7 rounded-3xl border border-border/70 bg-muted/15 p-5">
          {loading ? (
            <div className="grid min-h-80 place-items-center text-sm text-muted-foreground">
              Creating a private pairing code…
            </div>
          ) : error ? (
            <div className="grid min-h-72 place-items-center text-center">
              <div>
                <h3 className="font-medium">Remote is temporarily unavailable</h3>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{error}</p>
                <Button className="mt-5" onClick={() => void refresh()} variant="outline">
                  <RefreshCw className="size-4" />
                  Try again
                </Button>
              </div>
            </div>
          ) : accountLink ? (
            <div className="grid justify-items-center">
              <div className="rounded-[1.75rem] bg-white p-3 shadow-sm">
                {accountQrCode && !accountExpired ? (
                  <img
                    alt="Scan to connect this Mac to your Benaiah account"
                    className="size-72 max-h-[44vh] max-w-full rounded-2xl"
                    height="288"
                    src={accountQrCode}
                    width="288"
                  />
                ) : (
                  <div className="grid size-72 max-h-[44vh] max-w-full place-items-center rounded-2xl bg-neutral-100 px-8 text-center text-sm text-neutral-600">
                    This code has expired.
                  </div>
                )}
              </div>
              <p className="mt-4 text-sm font-medium">Scan with the phone you use for Benaiah</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {accountExpired
                  ? 'Refresh the code to continue.'
                  : `Connecting securely · code expires in ${remainingLabel(accountLink.expiresAt)}`}
              </p>
              <Button className="mt-4" onClick={() => void connectAccount()} size="sm" variant="outline">
                <RefreshCw className="size-4" />
                Refresh code
              </Button>
            </div>
          ) : !pairing?.linked ? (
            <div className="grid min-h-72 place-items-center text-center">
              <div>
                <h3 className="font-medium">Connect your Benaiah account first</h3>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                  Your computer and phone must use the same Benaiah account.
                </p>
                <Button
                  className="mt-5"
                  disabled={connectingAccount}
                  onClick={() => void connectAccount()}
                >
                  <QrCode className="size-4" />
                  {connectingAccount ? 'Creating code…' : 'Connect account'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid justify-items-center">
              <div className="rounded-[1.75rem] bg-white p-3 shadow-sm">
                {qrCode && !expired ? (
                  <img
                    alt="Scan to pair this computer with Benaiah on your phone"
                    className="size-72 max-h-[44vh] max-w-full rounded-2xl"
                    height="288"
                    src={qrCode}
                    width="288"
                  />
                ) : (
                  <div className="grid size-72 max-h-[44vh] max-w-full place-items-center rounded-2xl bg-neutral-100 px-8 text-center text-sm text-neutral-600">
                    This code has expired.
                  </div>
                )}
              </div>

              <div className="mt-4 flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="size-4" />
                <span>{pairing.deviceName || 'This Mac'}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {pairing.online ? 'Online' : 'Connecting'} · code expires in {remainingLabel(pairing.expiresAt)}
              </p>
              <Button className="mt-4" onClick={() => void refresh()} size="sm" variant="outline">
                <RefreshCw className="size-4" />
                Refresh code
              </Button>
            </div>
          )}
        </div>

        <div className="mt-5 rounded-2xl border border-border/60 px-4 py-3 text-sm">
          <p className="font-medium">Open your phone camera and scan.</p>
          <p className="mt-1 leading-5 text-muted-foreground">
            If you are already signed into Benaiah, your Mac connects and the remote opens automatically.
            The code works once, expires after five minutes and cannot pair another account.
          </p>
        </div>
      </div>
    </SettingsContent>
  )
}
