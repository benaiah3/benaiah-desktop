import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('Settings navigation', () => {
  it('keeps the Remote pairing page reachable from the sidebar', () => {
    const source = readFileSync('src/app/settings/index.tsx', 'utf8')

    expect(source).toContain("active: activeView === 'remote'")
    expect(source).toContain("id: 'remote'")
    expect(source).toContain('label: t.settings.nav.remote')
    expect(source).toContain("onSelect: () => setActiveView('remote')")
  })
})
