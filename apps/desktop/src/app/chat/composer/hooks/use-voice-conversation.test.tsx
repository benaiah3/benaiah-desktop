import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BargeMonitorCallbacks } from '@/lib/voice-barge-in'
import { setVoicePlaybackState } from '@/store/voice-playback'

import type { MicRecording } from './use-mic-recorder'
import { useVoiceConversation } from './use-voice-conversation'

// The full-duplex contract: the barge monitor is live across the WHOLE agent
// turn — generation (thinking) and playback (speaking) — so speaking over the
// model interrupts it mid-generation instead of the mic being deaf until TTS
// starts (the Windows report: interruption "never works" because the deaf
// window covered generation, and playback bleed made the old monitor's
// trigger unreachable).

const monitorCalls: BargeMonitorCallbacks[] = []
const stopMonitor = vi.fn()

vi.mock('@/lib/voice-barge-in', () => ({
  monitorSpeechDuringPlayback: (callbacks: BargeMonitorCallbacks) => {
    monitorCalls.push(callbacks)

    return stopMonitor
  }
}))

const markVoicePlaybackInterrupted = vi.fn()
const playSpeechText = vi.fn(async (_text: string, _options: { source: string; voice?: string }) => true)

const startSpeechStream = vi.fn(
  async (_options: {
    source: string
    voice?: string
  }): Promise<null | { append: (text: string) => void; done: Promise<'fallback'>; finish: () => void }> => null
)

const stopVoicePlayback = vi.fn()

vi.mock('@/lib/voice-playback', () => ({
  consumeUserStopRequested: vi.fn(() => false),
  markVoicePlaybackInterrupted: () => markVoicePlaybackInterrupted(),
  playSpeechText: (text: string, options: { source: string; voice?: string }) => playSpeechText(text, options),
  startSpeechStream: (options: { source: string; voice?: string }) => startSpeechStream(options),
  stopVoicePlayback: () => stopVoicePlayback()
}))

let thinkingSoundActive = false

vi.mock('@/lib/thinking-sound', () => ({
  isThinkingSoundActive: () => thinkingSoundActive,
  startThinkingSound: vi.fn(),
  stopThinkingSound: vi.fn()
}))

const micHandle = {
  cancel: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn<() => Promise<MicRecording | null>>(async () => null)
}

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: () => ({ handle: micHandle, level: 0, recording: false })
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      notifications: {
        voice: {
          configureSpeechToText: 'configure STT',
          couldNotStartSession: 'could not start',
          microphoneFailed: 'mic failed',
          playbackFailed: 'playback failed',
          transcriptionFailed: 'transcription failed',
          unavailable: 'unavailable'
        }
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

interface HookProps {
  busy: boolean
}

function renderConversation(
  overrides: {
    onInterrupt?: () => void
    pendingResponse?: () => { id: string; pending: boolean; text: string } | null
    transcript?: string
    voice?: string
  } = {}
) {
  const onInterrupt = overrides.onInterrupt ?? vi.fn()

  // Mirrors the real app: submitting a turn makes the agent busy.
  const onBusyChange: { current: (busy: boolean) => void } = { current: () => undefined }

  const onSubmit = vi.fn(async () => {
    onBusyChange.current(true)
  })

  const onStopWord = vi.fn()

  // First transcription is the turn that starts the conversation; subsequent
  // ones are barge captures (the overridable transcript).
  let transcriptions = 0

  const onTranscribeAudio = vi.fn(async () =>
    transcriptions++ === 0 ? 'kick off the task' : (overrides.transcript ?? 'and another thing')
  )

  const hook = renderHook(
    ({ busy }: HookProps) =>
      useVoiceConversation({
        busy,
        consumePendingResponse: vi.fn(),
        enabled: true,
        onInterrupt,
        onStopWord,
        onSubmit,
        onTranscribeAudio,
        pendingResponse: overrides.pendingResponse ?? (() => null),
        voice: overrides.voice
      }),
    { initialProps: { busy: false } }
  )

  onBusyChange.current = busy => hook.rerender({ busy })

  return { hook, onInterrupt, onStopWord, onSubmit, onTranscribeAudio }
}

/** Drive the hook into the generation phase (turn submitted, model working). */
async function enterThinking(hook: ReturnType<typeof renderConversation>['hook']) {
  await act(async () => {
    await hook.result.current.start()
  })
  await waitFor(() => expect(hook.result.current.status).toBe('listening'))

  micHandle.stop.mockResolvedValueOnce({
    audio: new Blob(['q'], { type: 'audio/webm' }),
    durationMs: 900,
    heardSpeech: true
  })

  await act(async () => {
    hook.result.current.stopTurn()
  })
  await waitFor(() => expect(hook.result.current.status).toBe('thinking'))
}

describe('useVoiceConversation full-duplex barge-in', () => {
  beforeEach(() => {
    monitorCalls.length = 0
    thinkingSoundActive = false
    vi.clearAllMocks()
    micHandle.start.mockResolvedValue(undefined)
    micHandle.stop.mockResolvedValue(null)
    setVoicePlaybackState({ audioElement: null, messageId: null, sequence: 0, source: null, status: 'idle' })
  })

  afterEach(cleanup)

  it('arms the barge monitor during generation (before any reply audio exists)', async () => {
    const { hook } = renderConversation()

    await act(async () => {
      await hook.result.current.start()
    })
    await enterThinking(hook)

    await waitFor(() => expect(hook.result.current.status).toBe('thinking'))
    // busy=true + thinking → the full-duplex monitor must be live.
    await waitFor(() => expect(monitorCalls.length).toBeGreaterThan(0))
  })

  it('treats the thinking cue as app audio so it cannot self-trigger barge-in', async () => {
    const { hook } = renderConversation()

    await enterThinking(hook)
    await waitFor(() => expect(monitorCalls.length).toBeGreaterThan(0))

    const monitor = monitorCalls.at(-1)
    expect(monitor?.isPlaying?.()).toBe(false)

    thinkingSoundActive = true
    expect(monitor?.isPlaying?.()).toBe(true)
  })

  it('keeps the echo-safe threshold through the TTS preparation gap', async () => {
    const { hook } = renderConversation()

    await enterThinking(hook)
    await waitFor(() => expect(monitorCalls.length).toBeGreaterThan(0))

    const monitor = monitorCalls.at(-1)
    thinkingSoundActive = false
    setVoicePlaybackState({
      audioElement: null,
      messageId: 'reply-1',
      sequence: 1,
      source: 'voice-conversation',
      status: 'preparing'
    })

    expect(monitor?.isPlaying?.()).toBe(true)

    setVoicePlaybackState({ audioElement: null, messageId: null, sequence: 1, source: null, status: 'idle' })
    expect(monitor?.isPlaying?.()).toBe(false)
  })

  it('speaks a fallback reply after a tool turn replaces its interim message id', async () => {
    let response: { id: string; pending: boolean; text: string } | null = null
    startSpeechStream.mockResolvedValueOnce({
      append: vi.fn(),
      done: Promise.resolve('fallback'),
      finish: vi.fn()
    })
    const { hook } = renderConversation({
      pendingResponse: () => response,
      voice: 'en-GB-SoniaNeural'
    })

    await enterThinking(hook)

    // The tool narration opens the speech path, whose provider reports that
    // it needs whole-text fallback on this machine.
    response = { id: 'interim', pending: true, text: 'Let me check that.' }
    hook.rerender({ busy: true })
    await waitFor(() =>
      expect(startSpeechStream).toHaveBeenCalledWith({
        source: 'voice-conversation',
        voice: 'en-GB-SoniaNeural'
      })
    )

    // Reconciliation briefly removes the interim bubble while generation is
    // still active. The old poll exited here and never called TTS.
    response = null
    await new Promise(resolve => window.setTimeout(resolve, 300))
    expect(playSpeechText).not.toHaveBeenCalled()

    // The authoritative final bubble has a different message id. It is still
    // the same logical turn and must be spoken.
    response = { id: 'final', pending: false, text: 'Today is Saturday, the first of August.' }
    hook.rerender({ busy: false })

    await waitFor(() =>
      expect(playSpeechText).toHaveBeenCalledWith('Today is Saturday, the first of August.', {
        source: 'voice-conversation',
        voice: 'en-GB-SoniaNeural'
      })
    )
  })

  it('interrupts the in-flight turn when speech trips mid-generation', async () => {
    const { hook, onInterrupt } = renderConversation()

    await act(async () => {
      await hook.result.current.start()
    })
    await enterThinking(hook)
    await waitFor(() => expect(monitorCalls.length).toBeGreaterThan(0))

    act(() => {
      monitorCalls.at(-1)?.onSpeech()
    })

    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(markVoicePlaybackInterrupted).toHaveBeenCalled()
    expect(stopVoicePlayback).toHaveBeenCalled()
  })

  it('submits the captured interruption once the interrupt settles (busy clears)', async () => {
    const { hook, onSubmit } = renderConversation({ transcript: 'no, do it differently' })

    await act(async () => {
      await hook.result.current.start()
    })
    await enterThinking(hook)
    await waitFor(() => expect(monitorCalls.length).toBeGreaterThan(0))

    const monitor = monitorCalls.at(-1)

    act(() => {
      monitor?.onSpeech()
    })

    // Interrupt lands → the turn ends → busy flips false.
    hook.rerender({ busy: false })

    await act(async () => {
      monitor?.onUtterance?.(new Blob(['x'], { type: 'audio/webm' }))
    })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('no, do it differently'))
  })

  it('does not interrupt when speech trips during playback (turn already done)', async () => {
    const { hook, onInterrupt } = renderConversation()

    await act(async () => {
      await hook.result.current.start()
    })
    await enterThinking(hook)
    await waitFor(() => expect(monitorCalls.length).toBeGreaterThan(0))

    // Turn finished; playback phase.
    hook.rerender({ busy: false })

    act(() => {
      monitorCalls.at(-1)?.onSpeech()
    })

    expect(onInterrupt).not.toHaveBeenCalled()
    expect(stopVoicePlayback).toHaveBeenCalled()
  })

  it('a spoken stop command in the barge capture ends the conversation instead of submitting', async () => {
    const { hook, onStopWord, onSubmit } = renderConversation({ transcript: 'stop' })

    await act(async () => {
      await hook.result.current.start()
    })
    await enterThinking(hook)
    await waitFor(() => expect(monitorCalls.length).toBeGreaterThan(0))

    const monitor = monitorCalls.at(-1)

    act(() => {
      monitor?.onSpeech()
    })
    hook.rerender({ busy: false })

    await act(async () => {
      monitor?.onUtterance?.(new Blob(['s'], { type: 'audio/webm' }))
    })

    await waitFor(() => expect(onStopWord).toHaveBeenCalledTimes(1))
    // Only the kickoff turn was submitted — the "stop" capture never was.
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalledWith('stop')
  })

  it('re-arms a single monitor per turn (idempotent ensure)', async () => {
    const { hook } = renderConversation()

    await act(async () => {
      await hook.result.current.start()
    })
    await enterThinking(hook)
    await waitFor(() => expect(monitorCalls.length).toBeGreaterThan(0))

    const armed = monitorCalls.length

    // Effect re-runs (busy toggles, status changes) must not open more mics.
    hook.rerender({ busy: true })
    hook.rerender({ busy: true })

    expect(monitorCalls.length).toBe(armed)
  })
})
