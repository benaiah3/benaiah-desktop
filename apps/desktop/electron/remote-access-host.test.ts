import assert from 'node:assert/strict'

import { test } from 'vitest'

import { RemoteAccessHost, parseRelayFrame } from './remote-access-host'

class FakeSocket {
  readyState = 0
  sent: string[] = []
  listeners: Record<string, Array<(event: any) => void>> = {}

  addEventListener(type: string, listener: (event: any) => void) {
    ;(this.listeners[type] ||= []).push(listener)
  }

  close() {
    this.readyState = 3
  }

  send(value: string) {
    this.sent.push(value)
  }

  emit(type: string, event: any = {}) {
    if (type === 'open') this.readyState = 1
    for (const listener of this.listeners[type] || []) listener(event)
  }
}

test('parses only scoped relay frames', () => {
  assert.deepEqual(
    parseRelayFrame(JSON.stringify({ v: 1, type: 'relay.frame', channel: 'c1', payload: '{}' })),
    { v: 1, type: 'relay.frame', channel: 'c1', payload: '{}' }
  )
  assert.equal(parseRelayFrame(JSON.stringify({ v: 1, type: 'relay.ready' })), null)
  assert.equal(parseRelayFrame('not-json'), null)
})

test('registers the host and forwards one client channel to the loopback gateway', async () => {
  const calls: Array<{ path: string; body: any }> = []
  const sockets: FakeSocket[] = []
  const statuses: string[] = []
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const body = JSON.parse(String(init?.body || '{}'))
    calls.push({ path, body })
    const payload = path.endsWith('/remote/ticket')
      ? { url: 'wss://relay.example/v1/connect', ticket: 'signed-ticket' }
      : { device: body }
    return new Response(JSON.stringify(payload), {
      status: path.endsWith('/remote/ticket') ? 201 : 201,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const host = new RemoteAccessHost({
    accessToken: 'bna_guest_token',
    appVersion: '0.25.0',
    deviceId: 'device_0123456789abcdef',
    deviceName: 'Test Mac',
    publicKey: 'A'.repeat(64),
    fetchImpl: fetchImpl as typeof fetch,
    localGatewayUrl: async () => 'ws://127.0.0.1:8642/api/ws?token=local',
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onStatus: status => statuses.push(status.state)
  })

  host.start()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls[0].path, '/api/remote/devices')
  assert.equal(calls[1].path, '/api/remote/ticket')
  assert.equal(sockets.length, 1)

  sockets[0].emit('open')
  sockets[0].emit('message', {
    data: JSON.stringify({
      v: 1,
      type: 'relay.frame',
      channel: 'mobile-1',
      payload: '{"jsonrpc":"2.0","id":1}'
    })
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(sockets.length, 2)
  sockets[1].emit('open')
  assert.deepEqual(sockets[1].sent, ['{"jsonrpc":"2.0","id":1}'])

  sockets[1].emit('message', { data: '{"jsonrpc":"2.0","id":1,"result":{}}' })
  assert.equal(
    JSON.parse(sockets[0].sent[0]).payload,
    '{"jsonrpc":"2.0","id":1,"result":{}}'
  )
  assert.deepEqual(statuses.slice(0, 2), ['connecting', 'online'])
  host.stop()
})
