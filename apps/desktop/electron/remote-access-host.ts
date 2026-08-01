type SocketEvent = {
  code?: number
  data?: unknown
  reason?: string
}

type SocketLike = {
  readyState: number
  addEventListener: (type: string, listener: (event: SocketEvent) => void) => void
  close: (code?: number, reason?: string) => void
  send: (value: string) => void
}

type RemoteHostOptions = {
  accessToken: string
  apiBaseUrl?: string
  appVersion: string
  deviceId: string
  deviceName: string
  localGatewayUrl: () => Promise<string>
  publicKey: string
  fetchImpl?: typeof fetch
  socketFactory?: (url: string) => SocketLike
  reconnectDelayMs?: number
  onStatus?: (status: RemoteHostStatus) => void
}

export type RemoteHostStatus =
  | { state: 'stopped' }
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'offline'; reason: string }

type RelayFrame = {
  v: 1
  type: 'relay.frame'
  channel: string
  payload: string
}

const OPEN = 1
const DEFAULT_API_BASE = 'https://benaiah.ai/api'

function eventReason(event: SocketEvent, fallback: string) {
  const reason = String(event?.reason || '').trim()

  return reason || (event?.code ? `${fallback} (${event.code})` : fallback)
}

function parseRelayFrame(data: unknown): RelayFrame | null {
  if (typeof data !== 'string') {
    return null
  }

  try {
    const frame = JSON.parse(data)

    if (
      frame?.v === 1 &&
      frame?.type === 'relay.frame' &&
      typeof frame.channel === 'string' &&
      typeof frame.payload === 'string'
    ) {
      return frame
    }
  } catch {
    // Presence and ready frames are intentionally ignored by this bridge.
  }

  return null
}

export class RemoteAccessHost {
  private readonly options: Required<
    Pick<RemoteHostOptions, 'apiBaseUrl' | 'fetchImpl' | 'reconnectDelayMs' | 'socketFactory'>
  > &
    RemoteHostOptions
  private relay: SocketLike | null = null
  private localSockets = new Map<string, SocketLike>()
  private localQueues = new Map<string, string[]>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(options: RemoteHostOptions) {
    this.options = {
      ...options,
      apiBaseUrl: String(options.apiBaseUrl || DEFAULT_API_BASE).replace(/\/$/, ''),
      fetchImpl: options.fetchImpl || fetch,
      reconnectDelayMs: options.reconnectDelayMs ?? 3_000,
      socketFactory: options.socketFactory || (url => new WebSocket(url) as unknown as SocketLike)
    }
  }

  start() {
    if (this.running) {
      return
    }

    this.running = true
    void this.connect()
  }

  stop() {
    this.running = false

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    this.reconnectTimer = null
    this.relay?.close(1000, 'Remote access stopped')
    this.relay = null
    this.closeLocalSockets()
    this.emit({ state: 'stopped' })
  }

  private emit(status: RemoteHostStatus) {
    this.options.onStatus?.(status)
  }

  private async request(path: string, body: Record<string, unknown>) {
    const response = await this.options.fetchImpl(`${this.options.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      throw new Error(String(payload?.error || `Remote access request failed (${response.status})`))
    }

    return payload
  }

  private async connect() {
    if (!this.running) {
      return
    }

    this.emit({ state: 'connecting' })

    try {
      await this.request('/remote/devices', {
        id: this.options.deviceId,
        name: this.options.deviceName,
        publicKey: this.options.publicKey,
        platform: process.platform,
        appVersion: this.options.appVersion
      })

      const ticket = await this.request('/remote/ticket', {
        role: 'host',
        deviceId: this.options.deviceId
      })

      const relayUrl = new URL(String(ticket.url))
      relayUrl.searchParams.set('ticket', String(ticket.ticket))
      this.openRelay(relayUrl.toString())
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Remote access could not connect')
    }
  }

  private openRelay(url: string) {
    const relay = this.options.socketFactory(url)
    this.relay = relay
    relay.addEventListener('open', () => {
      if (this.relay !== relay) {
        return
      }

      this.emit({ state: 'online' })
    })
    relay.addEventListener('message', event => {
      const frame = parseRelayFrame(event.data)

      if (frame) {
        void this.forwardToLocal(frame)
      }
    })
    relay.addEventListener('error', () => {
      if (this.relay === relay) {
        this.fail('The Benaiah relay connection failed')
      }
    })
    relay.addEventListener('close', event => {
      if (this.relay !== relay) {
        return
      }

      this.relay = null
      this.closeLocalSockets()

      if (this.running) {
        this.fail(eventReason(event, 'The Benaiah relay disconnected'))
      }
    })
  }

  private async forwardToLocal(frame: RelayFrame) {
    let socket = this.localSockets.get(frame.channel)

    if (!socket) {
      const localUrl = await this.options.localGatewayUrl()
      socket = this.options.socketFactory(localUrl)
      this.localSockets.set(frame.channel, socket)
      this.localQueues.set(frame.channel, [frame.payload])
      const channel = frame.channel
      socket.addEventListener('open', () => this.flushLocal(channel, socket as SocketLike))
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string' || this.relay?.readyState !== OPEN) {
          return
        }

        this.relay.send(
          JSON.stringify({
            v: 1,
            type: 'relay.frame',
            channel,
            payload: event.data
          })
        )
      })

      const close = () => {
        if (this.localSockets.get(channel) === socket) {
          this.localSockets.delete(channel)
          this.localQueues.delete(channel)
        }
      }

      socket.addEventListener('close', close)
      socket.addEventListener('error', close)

      return
    }

    if (socket.readyState === OPEN) {
      socket.send(frame.payload)
    } else {
      this.localQueues.get(frame.channel)?.push(frame.payload)
    }
  }

  private flushLocal(channel: string, socket: SocketLike) {
    const queue = this.localQueues.get(channel) || []

    for (const payload of queue) {
      socket.send(payload)
    }

    this.localQueues.set(channel, [])
  }

  private closeLocalSockets() {
    for (const socket of this.localSockets.values()) {
      socket.close(1000, 'Remote session ended')
    }

    this.localSockets.clear()
    this.localQueues.clear()
  }

  private fail(reason: string) {
    if (!this.running) {
      return
    }

    this.emit({ state: 'offline', reason })

    if (this.reconnectTimer) {
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, this.options.reconnectDelayMs)
  }
}

export { parseRelayFrame }
