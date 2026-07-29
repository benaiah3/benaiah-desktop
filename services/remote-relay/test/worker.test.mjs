import assert from 'node:assert/strict'
import { test } from 'node:test'

const { DeviceRelay } = await import('../src/worker.mjs')

function relay() {
  return new DeviceRelay({})
}

test('allows a host to stream a full response without tripping the client command limit', () => {
  const device = relay()
  for (let index = 0; index < 500; index += 1) {
    assert.equal(device.withinRateLimit('host-stream', 'host', 100), true)
  }
  assert.equal(device.withinRateLimit('host-stream', 'host', 100), false)
})

test('keeps the stricter command-frame limit for remote clients', () => {
  const device = relay()
  for (let index = 0; index < 80; index += 1) {
    assert.equal(device.withinRateLimit('client-commands', 'client', 100), true)
  }
  assert.equal(device.withinRateLimit('client-commands', 'client', 100), false)
})

test('applies independent byte budgets to clients and streaming hosts', () => {
  const device = relay()
  assert.equal(device.withinRateLimit('client-bytes', 'client', 2 * 1024 * 1024), true)
  assert.equal(device.withinRateLimit('client-bytes', 'client', 1), false)
  assert.equal(device.withinRateLimit('host-bytes', 'host', 8 * 1024 * 1024), true)
  assert.equal(device.withinRateLimit('host-bytes', 'host', 1), false)
})
