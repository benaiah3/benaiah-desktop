const encoder = new TextEncoder()

function decodeBase64Url(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0))
}

function decodePayload(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)))
}

function safeEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false
  let result = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    result |= left[index] ^ right[index]
  }
  return result === 0
}

export async function verifyRelayTicket(value, secret, now = Math.floor(Date.now() / 1000)) {
  const [encoded, suppliedSignature] = String(value || '').split('.')
  if (!encoded || !suppliedSignature || String(secret || '').length < 32) return null

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(encoded)),
    )
    const supplied = decodeBase64Url(suppliedSignature)
    if (!safeEqual(expected, supplied)) return null

    const payload = decodePayload(encoded)
    if (
      payload?.v !== 1
      || !/^[a-f0-9]{64}$/.test(String(payload.account || ''))
      || !/^[A-Za-z0-9_-]{16,96}$/.test(String(payload.deviceId || ''))
      || !['host', 'client'].includes(payload.role)
      || !/^[A-Za-z0-9_-]{16,96}$/.test(String(payload.jti || ''))
      || Number(payload.exp) <= now
      || Number(payload.iat) > now + 30
      || Number(payload.exp) - Number(payload.iat) > 90
    ) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

export function relayObjectName(claims) {
  return `${claims.account}:${claims.deviceId}`
}
