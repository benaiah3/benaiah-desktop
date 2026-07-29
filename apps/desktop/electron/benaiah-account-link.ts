const ACCOUNT_LINK_ORIGIN = 'https://benaiah.ai'
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,96}$/

export function prepareBenaiahAccountLink(
  linkUrl: string,
  options: { deviceId?: string; returnToRemote?: boolean } = {}
) {
  const parsed = new URL(linkUrl)

  if (
    parsed.origin !== ACCOUNT_LINK_ORIGIN
    || parsed.pathname !== '/settings'
    || !parsed.searchParams.get('code')
    || parsed.hash !== '#profile'
  ) {
    throw new Error('Benaiah did not return a valid account link.')
  }

  if (options.returnToRemote) {
    const deviceId = String(options.deviceId || '')
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw new Error('Benaiah could not identify this Mac for remote access.')
    }
    parsed.searchParams.set('next', 'remote')
    parsed.searchParams.set('device', deviceId)
  }

  return parsed.toString()
}
