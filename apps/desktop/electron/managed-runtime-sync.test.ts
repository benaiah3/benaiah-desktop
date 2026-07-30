import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { synchronizeManagedRuntime } from './managed-runtime-sync'

describe('synchronizeManagedRuntime', () => {
  it('does not move a dirty checkout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benaiah-managed-runtime-'))

    fs.mkdirSync(path.join(root, '.git'))
    const calls: string[][] = []
    const result = synchronizeManagedRuntime(root, 'a'.repeat(40), args => {
      calls.push(args)

      if (args[0] === 'rev-parse') {
        return 'b'.repeat(40)
      }

      if (args[0] === 'status') {
        return ' M user-file'
      }

      return ''
    })

    expect(result).toEqual({ state: 'skipped', reason: 'dirty' })
    expect(calls.map(args => args[0])).toEqual(['rev-parse', 'status'])

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('checks out the stamped commit only from the reviewed Benaiah remote', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benaiah-managed-runtime-'))

    fs.mkdirSync(path.join(root, '.git'))
    const target = 'a'.repeat(40)
    const calls: string[][] = []
    const result = synchronizeManagedRuntime(root, target, args => {
      calls.push(args)

      if (args[0] === 'rev-parse') {
        return 'b'.repeat(40)
      }

      if (args[0] === 'status') {
        return ''
      }

      if (args[0] === 'remote') {
        return 'git@github.com:benaiah3/benaiah-desktop.git'
      }

      return ''
    })

    expect(result).toEqual({ state: 'updated', from: 'b'.repeat(40), to: target })
    expect(calls.at(-1)).toEqual(['checkout', '--detach', target])

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('refuses to update a checkout from another origin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benaiah-managed-runtime-'))

    fs.mkdirSync(path.join(root, '.git'))
    const result = synchronizeManagedRuntime(root, 'a'.repeat(40), args => {
      if (args[0] === 'rev-parse') {
        return 'b'.repeat(40)
      }

      if (args[0] === 'status') {
        return ''
      }

      if (args[0] === 'remote') {
        return 'https://github.com/example/other.git'
      }

      return ''
    })

    expect(result).toEqual({ state: 'skipped', reason: 'untrusted-remote' })

    fs.rmSync(root, { recursive: true, force: true })
  })
})
