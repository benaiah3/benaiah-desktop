import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CODEX_INTENSITIES = ['low', 'medium', 'high', 'extra-high', 'pro'] as const

export type CodexIntensity = (typeof CODEX_INTENSITIES)[number]

export interface CodexIntelligenceStatus {
  supported: boolean
  installed: boolean
  enabled: boolean
  intensity: CodexIntensity
  label: string
  reason?: string
  restarted?: boolean
}

interface CommandResult {
  stderr: string
  stdout: string
}

interface CodexIntelligenceControlOptions {
  platform?: NodeJS.Platform
  wrapperPath?: string
  wrapperExists?: (target: string) => boolean
  runCommand?: (file: string, args: string[]) => Promise<CommandResult>
  restartCodexIfRunning?: () => Promise<boolean>
}

const LABELS: Record<CodexIntensity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  'extra-high': 'Extra High',
  pro: 'Pro'
}

function normalizeIntensity(value: unknown): CodexIntensity {
  const normalized = String(value || 'high')
    .trim()
    .toLowerCase()
    .replaceAll('_', '-')
    .replaceAll(' ', '-')

  if ((CODEX_INTENSITIES as readonly string[]).includes(normalized)) {
    return normalized as CodexIntensity
  }

  if (normalized === 'xhigh') {
    return 'extra-high'
  }

  throw new Error('Choose Low, Medium, High, Extra High or Pro.')
}

export function parseCodexIntelligenceStatus(output: string): Pick<CodexIntelligenceStatus, 'enabled' | 'intensity' | 'label'> {
  const line = String(output || '').match(/^Codex default:\s*(.+)$/im)?.[1]?.trim() || ''
  const enabled = /^Benaiah\b/i.test(line)
  const reported = enabled ? line.split('·').slice(1).join('·').trim() : ''
  const intensity = normalizeIntensity(reported || 'high')

  return {
    enabled,
    intensity,
    label: enabled ? `Benaiah ${LABELS[intensity]}` : 'OpenAI intelligence'
  }
}

function defaultRunCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).replace(/\s+/g, ' ').trim()
        reject(new Error(detail || 'Codex could not be switched.'))

        return
      }

      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

export class CodexIntelligenceControl {
  private readonly options: Required<Omit<CodexIntelligenceControlOptions, 'restartCodexIfRunning'>> &
    Pick<CodexIntelligenceControlOptions, 'restartCodexIfRunning'>

  constructor(options: CodexIntelligenceControlOptions = {}) {
    this.options = {
      platform: options.platform || process.platform,
      wrapperPath: options.wrapperPath || path.join(os.homedir(), '.local', 'bin', 'codex-benaiah'),
      wrapperExists: options.wrapperExists || fs.existsSync,
      runCommand: options.runCommand || defaultRunCommand,
      restartCodexIfRunning: options.restartCodexIfRunning
    }
  }

  async status(): Promise<CodexIntelligenceStatus> {
    if (this.options.platform !== 'darwin') {
      return {
        supported: false,
        installed: false,
        enabled: false,
        intensity: 'high',
        label: 'Available on macOS',
        reason: 'The seamless Codex intelligence switch currently requires macOS.'
      }
    }

    if (!this.options.wrapperExists(this.options.wrapperPath)) {
      return {
        supported: true,
        installed: false,
        enabled: false,
        intensity: 'high',
        label: 'Benaiah Bar required',
        reason: 'Install Benaiah Bar on this Mac to control Codex remotely.'
      }
    }

    try {
      const result = await this.options.runCommand(this.options.wrapperPath, ['status'])

      return {
        supported: true,
        installed: true,
        ...parseCodexIntelligenceStatus(result.stdout)
      }
    } catch (error) {
      return {
        supported: true,
        installed: true,
        enabled: false,
        intensity: 'high',
        label: 'Codex status unavailable',
        reason: error instanceof Error ? error.message : 'Codex status could not be checked.'
      }
    }
  }

  async switch(params: { enabled?: unknown; intensity?: unknown } = {}): Promise<CodexIntelligenceStatus> {
    const before = await this.status()

    if (!before.supported || !before.installed) {
      throw new Error(before.reason || before.label)
    }

    const enabled = params.enabled === true
    const intensity = normalizeIntensity(params.intensity)
    const args = enabled ? ['on', intensity] : ['off']

    await this.options.runCommand(this.options.wrapperPath, args)
    const restarted = (await this.options.restartCodexIfRunning?.()) || false
    const after = await this.status()

    return { ...after, restarted }
  }
}
