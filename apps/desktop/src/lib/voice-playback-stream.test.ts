import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hermes/shared', () => ({ resolveGatewayWsUrl: vi.fn(async () => 'ws://localhost/api/ws') }))
vi.mock('@/hermes', () => ({
  getApiRequestProfile: vi.fn(() => null),
  speakText: vi.fn(async () => ({ data_url: 'data:audio/wav;base64,' }))
}))

import { $voicePlayback } from '@/store/voice-playback'

import { startSpeechStream, stopVoicePlayback } from './voice-playback'

class FakeAudioContext {
  currentTime = 0
  destination = {}
  state = 'running'

  close() {
    return Promise.resolve()
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length)
    }
  }

  createBufferSource() {
    return { buffer: null, connect: vi.fn(), start: vi.fn() }
  }

  resume() {
    return Promise.resolve()
  }
}

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static instances: FakeWebSocket[] = []

  binaryType = ''
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null
  onopen: (() => void) | null = null
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  send(data: string) {
    this.sent.push(data)
  }

  message(data: ArrayBuffer | string) {
    this.onmessage?.({ data })
  }
}

describe('streaming voice playback lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances.length = 0
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { getConnection: vi.fn(async () => ({})) }
    })
  })

  afterEach(() => {
    stopVoicePlayback()
    vi.clearAllTimers()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reports preparing, speaking, then idle only after audio drains', async () => {
    const statuses: string[] = []
    const unsubscribe = $voicePlayback.subscribe(state => statuses.push(state.status))
    const session = await startSpeechStream({ messageId: 'reply-1', source: 'voice-conversation' })
    const ws = FakeWebSocket.instances.at(-1)

    expect(session).not.toBeNull()
    expect($voicePlayback.get().status).toBe('preparing')

    ws?.open()
    ws?.message(JSON.stringify({ sample_rate: 24_000, type: 'start' }))
    ws?.message(new Int16Array(2_400).buffer)
    expect($voicePlayback.get().status).toBe('speaking')

    session?.finish()
    ws?.message(JSON.stringify({ type: 'end' }))
    await vi.advanceTimersByTimeAsync(250)
    expect(await session?.done).toBe('done')
    expect($voicePlayback.get().status).toBe('idle')
    expect(statuses).toEqual(expect.arrayContaining(['preparing', 'speaking', 'idle']))
    unsubscribe()
  })

  it('carries the wake-selected voice into the speech session URL', async () => {
    const session = await startSpeechStream({
      source: 'voice-conversation',
      voice: 'en-GB-SoniaNeural'
    })
    const ws = FakeWebSocket.instances.at(-1)

    expect(ws?.url).toContain('voice=en-GB-SoniaNeural')

    stopVoicePlayback()
    expect(await session?.done).toBe('cancelled')
  })

  it('keeps cancellation distinct and stable across twenty consecutive turns', async () => {
    for (let turn = 0; turn < 20; turn += 1) {
      const session = await startSpeechStream({ messageId: `reply-${turn}`, source: 'voice-conversation' })

      expect($voicePlayback.get().status).toBe('preparing')
      stopVoicePlayback()
      expect(await session?.done).toBe('cancelled')
      expect($voicePlayback.get().status).toBe('idle')
    }
  })

  it('cannot let a cancelled old session reset a newer preparing session', async () => {
    const oldSession = await startSpeechStream({ messageId: 'old', source: 'voice-conversation' })
    const newSession = await startSpeechStream({ messageId: 'new', source: 'voice-conversation' })

    expect(await oldSession?.done).toBe('cancelled')
    expect($voicePlayback.get()).toMatchObject({ messageId: 'new', status: 'preparing' })

    stopVoicePlayback()
    expect(await newSession?.done).toBe('cancelled')
  })
})
