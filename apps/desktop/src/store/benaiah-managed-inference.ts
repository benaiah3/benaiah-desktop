import {
  deleteCustomEndpoint,
  deleteEnvVar,
  disconnectOAuthProvider,
  getCustomEndpoints,
  getEnvVars,
  listOAuthProviders
} from '@/hermes'
import type { EnvVarInfo } from '@/types/hermes'

const MIGRATION_KEY = 'benaiah-managed-inference-v1'

export function isLegacyModelProviderCredential(info: EnvVarInfo): boolean {
  // This is the critical boundary: tool, MCP, messaging, memory and connector
  // secrets must remain intact. Only backend-declared inference-provider
  // credentials are retired.
  return info.category === 'provider' && info.is_set
}

function migrationStorageKey(profile: string): string {
  return `${MIGRATION_KEY}:${profile.trim() || 'default'}`
}

export async function retireLegacyModelProviderAccess(profile = 'default'): Promise<{
  endpointsRemoved: number
  keysRemoved: number
  oauthRemoved: number
  skipped: boolean
}> {
  const storageKey = migrationStorageKey(profile)

  try {
    if (window.localStorage.getItem(storageKey) === '1') {
      return { endpointsRemoved: 0, keysRemoved: 0, oauthRemoved: 0, skipped: true }
    }
  } catch {
    // Storage can be unavailable in hardened renderer contexts. Cleanup is
    // idempotent, so continue and let the backend remain authoritative.
  }

  const [vars, custom, oauth] = await Promise.all([
    getEnvVars(),
    getCustomEndpoints().catch(() => ({ endpoints: [] })),
    listOAuthProviders().catch(() => ({ providers: [] }))
  ])

  const providerKeys = Object.entries(vars)
    .filter(([, info]) => isLegacyModelProviderCredential(info))
    .map(([key]) => key)

  const endpoints = custom.endpoints ?? []

  const connectedOAuth = (oauth.providers ?? []).filter(
    provider => provider.status?.logged_in && (provider.disconnectable ?? provider.flow !== 'external')
  )

  await Promise.all([
    ...providerKeys.map(key => deleteEnvVar(key)),
    ...endpoints.map(endpoint => deleteCustomEndpoint(endpoint.id)),
    ...connectedOAuth.map(provider => disconnectOAuthProvider(provider.id))
  ])

  try {
    window.localStorage.setItem(storageKey, '1')
  } catch {
    // The work is complete even if the optimization marker cannot persist.
  }

  return {
    endpointsRemoved: endpoints.length,
    keysRemoved: providerKeys.length,
    oauthRemoved: connectedOAuth.length,
    skipped: false
  }
}
