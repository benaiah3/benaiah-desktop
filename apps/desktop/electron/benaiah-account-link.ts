const ACCOUNT_LINK_ORIGIN = 'https://benaiah.ai'
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,96}$/
const BROWSER_LINK_CODE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function prepareBenaiahAccountLink(
  linkUrl: string,
  options: { deviceId?: string; returnToRemote?: boolean } = {}
) {
  const parsed = new URL(linkUrl)

  if (
    parsed.origin !== ACCOUNT_LINK_ORIGIN ||
    parsed.pathname !== '/settings' ||
    !parsed.searchParams.get('code') ||
    parsed.hash !== '#profile'
  ) {
    throw new Error('Benaiah did not return a valid account link.')
  }

  if (options.returnToRemote) {
    const deviceId = String(options.deviceId || '')

    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new Error('Benaiah could not identify this computer for remote access.')
    }

    parsed.searchParams.set('next', 'remote')
    parsed.searchParams.set('device', deviceId)
  }

  return parsed.toString()
}

export function benaiahBrowserLinkCode(linkUrl: string) {
  let parsed: URL

  try {
    parsed = new URL(linkUrl)
  } catch {
    return null
  }

  const code = parsed.searchParams.get('code') || ''

  if (
    parsed.protocol !== 'benaiah:' ||
    parsed.hostname !== 'browser-link' ||
    parsed.pathname !== '' ||
    code.length > 4096 ||
    !BROWSER_LINK_CODE_PATTERN.test(code)
  ) {
    return null
  }

  return code
}

export function benaiahBrowserLinkPrompt(email: string) {
  const account = String(email || '').trim()

  return {
    message: 'Connect Benaiah for Chrome?',
    detail: account
      ? `Allow this Chrome profile to use ${account} for See, Chat and Work. Your Benaiah Work credential is never shared.`
      : 'Allow this Chrome profile to use your Benaiah account for See, Chat and Work. Your Benaiah Work credential is never shared.'
  }
}
