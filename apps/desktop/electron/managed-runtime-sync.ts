import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const COMMIT_RE = /^[0-9a-f]{7,40}$/i
const BENAIAH_REMOTE_RE = /(?:github\.com[:/])benaiah3\/benaiah-desktop(?:\.git)?$/i

type GitRunner = (args: string[], cwd: string) => string

export type ManagedRuntimeSyncResult =
  | { state: 'current'; commit: string }
  | { state: 'updated'; from: string; to: string }
  | { state: 'skipped'; reason: 'missing' | 'invalid-commit' | 'dirty' | 'untrusted-remote' }
  | { state: 'failed'; reason: string }

function defaultGitRunner(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    windowsHide: true
  }).trim()
}

/**
 * Keep the separately installed local Python runtime aligned with the commit
 * stamped into a signed desktop release. The runtime is only moved when it is
 * the managed Benaiah checkout, clean, and backed by Benaiah's reviewed
 * repository. User-owned or modified checkouts are never overwritten.
 */
export function synchronizeManagedRuntime(
  activeRoot: string,
  targetCommit: string,
  runGit: GitRunner = defaultGitRunner
): ManagedRuntimeSyncResult {
  if (!activeRoot || !fs.existsSync(path.join(activeRoot, '.git'))) {
    return { state: 'skipped', reason: 'missing' }
  }

  if (!COMMIT_RE.test(targetCommit)) {
    return { state: 'skipped', reason: 'invalid-commit' }
  }

  try {
    const current = runGit(['rev-parse', 'HEAD'], activeRoot)

    if (current === targetCommit) {
      return { state: 'current', commit: current }
    }

    if (runGit(['status', '--porcelain'], activeRoot)) {
      return { state: 'skipped', reason: 'dirty' }
    }

    const origin = runGit(['remote', 'get-url', 'origin'], activeRoot)

    if (!BENAIAH_REMOTE_RE.test(origin)) {
      return { state: 'skipped', reason: 'untrusted-remote' }
    }

    try {
      runGit(['cat-file', '-e', `${targetCommit}^{commit}`], activeRoot)
    } catch {
      runGit(['fetch', '--no-tags', '--depth=1', 'origin', targetCommit], activeRoot)
    }

    runGit(['checkout', '--detach', targetCommit], activeRoot)

    return { state: 'updated', from: current, to: targetCommit }
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
