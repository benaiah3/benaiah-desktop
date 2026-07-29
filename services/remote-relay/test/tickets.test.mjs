import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webcrypto } from 'node:crypto'

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = value => Buffer.from(value, 'base64').toString('binary')
}

const { relayObjectName, verifyRelayTicket } = await import('../src/tickets.mjs')

const secret = 'test-remote-relay-secret-that-is-long-enough'

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

async function ticket(payload) {
  const body = encode(payload)
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = Buffer.from(
    await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  ).toString('base64url')
  return `${body}.${signature}`
}

test('verifies a short-lived scoped relay ticket', async () => {
  const now = 1_785_300_000
  const payload = {
    v: 1,
    account: 'a'.repeat(64),
    deviceId: 'device_0123456789abcdef',
    role: 'client',
    jti: 'ticket_0123456789abcdef',
    iat: now,
    exp: now + 60,
  }
  const claims = await verifyRelayTicket(await ticket(payload), secret, now)
  assert.deepEqual(claims, payload)
  assert.equal(relayObjectName(claims), `${payload.account}:${payload.deviceId}`)
})

test('rejects expired, overlong, altered and elevated tickets', async () => {
  const now = 1_785_300_000
  const base = {
    v: 1,
    account: 'b'.repeat(64),
    deviceId: 'device_0123456789abcdef',
    role: 'host',
    jti: 'ticket_0123456789abcdef',
    iat: now,
    exp: now + 60,
  }
  assert.equal(await verifyRelayTicket(await ticket({ ...base, exp: now }), secret, now), null)
  assert.equal(await verifyRelayTicket(await ticket({ ...base, exp: now + 120 }), secret, now), null)
  assert.equal(await verifyRelayTicket(await ticket({ ...base, role: 'admin' }), secret, now), null)
  const valid = await ticket(base)
  assert.equal(await verifyRelayTicket(`${valid.slice(0, -1)}x`, secret, now), null)
})
