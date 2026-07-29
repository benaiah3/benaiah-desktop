import { relayObjectName, verifyRelayTicket } from './tickets.mjs'

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_CLIENTS = 4
const RATE_WINDOW_MS = 1000
const MAX_CLIENT_FRAMES_PER_WINDOW = 80
const MAX_HOST_FRAMES_PER_WINDOW = 500
const MAX_CLIENT_BYTES_PER_WINDOW = 2 * 1024 * 1024
const MAX_HOST_BYTES_PER_WINDOW = 8 * 1024 * 1024

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function websocketTicket(request) {
  const url = new URL(request.url)
  return String(url.searchParams.get('ticket') || '')
}

function allowedClientOrigin(request, env) {
  const origin = String(request.headers.get('Origin') || '')
  const allowed = String(env.BENAIAH_ALLOWED_ORIGINS || 'https://benaiah.ai')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  return allowed.includes(origin)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      return json(200, { ok: true, service: 'benaiah-remote-relay', version: 1 })
    }
    if (url.pathname !== '/v1/connect' || request.headers.get('Upgrade') !== 'websocket') {
      return json(404, { error: 'Not found' })
    }

    const claims = await verifyRelayTicket(
      websocketTicket(request),
      env.BENAIAH_REMOTE_RELAY_SECRET,
    )
    if (!claims) return json(401, { error: 'The remote access ticket is invalid or expired' })
    if (claims.role === 'client' && !allowedClientOrigin(request, env)) {
      return json(403, { error: 'This origin is not allowed to control a computer' })
    }

    const objectId = env.DEVICE_RELAY.idFromName(relayObjectName(claims))
    const relay = env.DEVICE_RELAY.get(objectId)
    const headers = new Headers(request.headers)
    headers.set('X-Benaiah-Relay-Role', claims.role)
    headers.set('X-Benaiah-Relay-Jti', claims.jti)
    headers.set('X-Benaiah-Relay-Exp', String(claims.exp))
    headers.delete('Cookie')
    return relay.fetch(new Request('https://device.internal/connect', {
      method: 'GET',
      headers,
    }))
  },
}

export class DeviceRelay {
  constructor(state) {
    this.state = state
    this.rate = new Map()
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json(426, { error: 'WebSocket upgrade required' })
    }

    const role = request.headers.get('X-Benaiah-Relay-Role')
    const jti = request.headers.get('X-Benaiah-Relay-Jti')
    const exp = Number(request.headers.get('X-Benaiah-Relay-Exp') || 0)
    if (!['host', 'client'].includes(role) || !jti || exp <= Date.now() / 1000) {
      return json(401, { error: 'The relay session is not authorised' })
    }

    const usedKey = `ticket:${jti}`
    if (await this.state.storage.get(usedKey)) {
      return json(409, { error: 'This relay ticket has already been used' })
    }
    await this.state.storage.put(usedKey, exp)
    await this.pruneUsedTickets()

    const hosts = this.state.getWebSockets('host')
    const clients = this.state.getWebSockets('client')
    if (role === 'client' && clients.length >= MAX_CLIENTS) {
      return json(429, { error: 'This computer already has the maximum remote sessions' })
    }

    const connectionId = crypto.randomUUID()
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.serializeAttachment({ v: 1, role, connectionId })

    if (role === 'host') {
      for (const existing of hosts) {
        existing.close(4000, 'A newer host connection replaced this one')
      }
    }
    this.state.acceptWebSocket(server, [role])
    server.send(JSON.stringify({
      v: 1,
      type: 'relay.ready',
      role,
      connectionId,
      peerCount: role === 'host' ? clients.length : hosts.length,
    }))
    this.notifyPresence(role, connectionId, true)

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  async pruneUsedTickets() {
    const records = await this.state.storage.list({ prefix: 'ticket:' })
    const now = Math.floor(Date.now() / 1000)
    const expired = []
    for (const [key, expiry] of records) {
      if (Number(expiry) <= now) expired.push(key)
    }
    if (expired.length) await this.state.storage.delete(expired)
  }

  withinRateLimit(connectionId, role, byteLength) {
    const now = Date.now()
    const current = this.rate.get(connectionId)
    if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
      this.rate.set(connectionId, { startedAt: now, count: 1, bytes: byteLength })
      return byteLength <= (role === 'host' ? MAX_HOST_BYTES_PER_WINDOW : MAX_CLIENT_BYTES_PER_WINDOW)
    }
    current.count += 1
    current.bytes += byteLength
    const maxFrames = role === 'host' ? MAX_HOST_FRAMES_PER_WINDOW : MAX_CLIENT_FRAMES_PER_WINDOW
    const maxBytes = role === 'host' ? MAX_HOST_BYTES_PER_WINDOW : MAX_CLIENT_BYTES_PER_WINDOW
    return current.count <= maxFrames && current.bytes <= maxBytes
  }

  webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment()
    const byteLength = typeof message === 'string'
      ? new TextEncoder().encode(message).byteLength
      : Number(message?.byteLength || 0)
    if (byteLength > MAX_FRAME_BYTES || typeof message !== 'string') {
      socket.close(4409, 'Remote frame is too large or unsupported')
      return
    }
    if (!attachment || !this.withinRateLimit(attachment.connectionId, attachment.role, byteLength)) {
      socket.close(4408, 'Remote session rate limit exceeded')
      return
    }

    if (attachment.role === 'client') {
      const host = this.state.getWebSockets('host')[0]
      if (!host) {
        socket.send(JSON.stringify({ v: 1, type: 'relay.offline' }))
        return
      }
      host.send(JSON.stringify({
        v: 1,
        type: 'relay.frame',
        channel: attachment.connectionId,
        payload: message,
      }))
      return
    }

    let frame
    try {
      frame = JSON.parse(message)
    } catch {
      socket.close(4400, 'Host frames must use the relay envelope')
      return
    }
    if (
      frame?.v !== 1
      || frame?.type !== 'relay.frame'
      || typeof frame.channel !== 'string'
      || typeof frame.payload !== 'string'
    ) {
      socket.close(4400, 'Host relay envelope is invalid')
      return
    }
    const client = this.state.getWebSockets('client').find(candidate => {
      return candidate.deserializeAttachment()?.connectionId === frame.channel
    })
    if (client) client.send(frame.payload)
  }

  webSocketClose(socket) {
    const attachment = socket.deserializeAttachment()
    if (!attachment) return
    this.rate.delete(attachment.connectionId)
    this.notifyPresence(attachment.role, attachment.connectionId, false)
  }

  webSocketError(socket) {
    const attachment = socket.deserializeAttachment()
    if (attachment) this.rate.delete(attachment.connectionId)
  }

  notifyPresence(role, connectionId, online) {
    const targets = role === 'host'
      ? this.state.getWebSockets('client')
      : this.state.getWebSockets('host')
    const message = JSON.stringify({
      v: 1,
      type: 'relay.presence',
      role,
      connectionId,
      online,
    })
    for (const socket of targets) socket.send(message)
  }
}
