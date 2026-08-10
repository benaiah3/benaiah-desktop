import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { CodexIntelligenceControl, parseCodexIntelligenceStatus } from './codex-intelligence-control'

describe('Codex intelligence control', () => {
  test('reads the provider and exact Benaiah intensity from the wrapper receipt', () => {
    assert.deepEqual(parseCodexIntelligenceStatus('Codex default: Benaiah · Extra High\n'), {
      enabled: true,
      intensity: 'extra-high',
      label: 'Benaiah Extra High'
    })
    assert.deepEqual(parseCodexIntelligenceStatus('Codex default: your own OpenAI/ChatGPT login\n'), {
      enabled: false,
      intensity: 'high',
      label: 'OpenAI intelligence'
    })
  })

  test('fails closed on unsupported platforms without running a command', async () => {
    let commands = 0

    const control = new CodexIntelligenceControl({
      platform: 'win32',
      runCommand: async () => {
        commands += 1

        return { stdout: '', stderr: '' }
      }
    })

    const status = await control.status()
    assert.equal(status.supported, false)
    assert.equal(commands, 0)
    await assert.rejects(() => control.switch({ enabled: true }), /requires macOS/i)
  })

  test('uses only the allowlisted wrapper arguments and returns confirmed state', async () => {
    const commands: string[][] = []
    let enabled = false
    let intensity = 'high'
    let restarts = 0

    const control = new CodexIntelligenceControl({
      platform: 'darwin',
      wrapperPath: '/safe/codex-benaiah',
      wrapperExists: () => true,
      runCommand: async (_file, args) => {
        commands.push(args)

        if (args[0] === 'on') {
          enabled = true
          intensity = args[1]
        } else if (args[0] === 'off') {
          enabled = false
        }

        const label = intensity === 'extra-high' ? 'Extra High' : 'High'

        return {
          stdout: args[0] === 'status'
            ? `Codex default: ${enabled ? `Benaiah · ${label}` : 'your own OpenAI/ChatGPT login'}\n`
            : '',
          stderr: ''
        }
      },
      restartCodexIfRunning: async () => {
        restarts += 1

        return true
      }
    })

    const switched = await control.switch({ enabled: true, intensity: 'extra high' })
    assert.equal(switched.enabled, true)
    assert.equal(switched.intensity, 'extra-high')
    assert.equal(switched.restarted, true)
    assert.deepEqual(commands, [['status'], ['on', 'extra-high'], ['status']])
    assert.equal(restarts, 1)

    await assert.rejects(() => control.switch({ enabled: true, intensity: 'ultra' }), /Choose Low/)
    assert.equal(commands.some(args => args.includes('ultra')), false)
  })
})
