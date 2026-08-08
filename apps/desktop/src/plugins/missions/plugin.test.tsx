import { describe, expect, it, vi } from 'vitest'

import plugin from './plugin'

describe('Benaiah Missions plugin', () => {
  it('registers one operator page and one matching sidebar route', () => {
    const registerMany = vi.fn()

    plugin.register({ registerMany } as never)

    expect(plugin.id).toBe('missions')
    expect(plugin.defaultEnabled).toBe(true)
    expect(registerMany).toHaveBeenCalledOnce()
    const contributions = registerMany.mock.calls[0]?.[0] as Array<{ area: string; data: { path: string } }>

    expect(contributions).toHaveLength(2)
    expect(contributions.map(item => item.data.path)).toEqual(['/missions', '/missions'])
    expect(contributions.map(item => item.area)).toEqual(['routes', 'sidebar.nav'])
  })
})
