import {
  Badge,
  Button,
  Codicon,
  type HermesPlugin,
  host,
  Input,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  StatusDot,
  type StatusTone,
  Textarea,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useState } from 'react'

type MissionStatus =
  | 'awaiting_approval'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'paused'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

interface MissionReceipt {
  attempts: number
  changed_file_count: number | null
  completed_at: number | null
  duration_seconds: number | null
  observed_cost_gbp: number | null
  retries: number
  status: string
  verifier_verdict?: { passed?: boolean; summary?: string } | null
}

interface Mission {
  approved_at: number | null
  created_at: number
  current_attempt: number
  current_phase: string | null
  id: string
  intelligence_tier: 'instant' | 'medium' | 'high' | 'extra_high' | 'pro'
  last_error: string | null
  max_retries: number
  objective: string
  permission_mode: 'read_only' | 'workspace_write' | 'full_access'
  receipt: MissionReceipt | null
  selected_verifier_runtime: string | null
  selected_worker_runtime: string | null
  status: MissionStatus
  success_criteria: string
  task_status: string | null
  title: string
  verifier_runtime: string
  worker_runtime: string
  workspace: string | null
}

const STATUS_LABEL: Record<MissionStatus, string> = {
  awaiting_approval: 'Needs approval',
  queued: 'Queued',
  running: 'Working',
  verifying: 'Verifying',
  paused: 'Paused',
  blocked: 'Needs attention',
  succeeded: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const TIER_LABEL: Record<Mission['intelligence_tier'], string> = {
  instant: 'Benaiah Instant',
  medium: 'Benaiah Medium',
  high: 'Benaiah High',
  extra_high: 'Benaiah Extra High',
  pro: 'Benaiah Pro'
}

const STATUS_TONE: Record<MissionStatus, StatusTone> = {
  awaiting_approval: 'warn',
  queued: 'muted',
  running: 'good',
  verifying: 'good',
  paused: 'muted',
  blocked: 'warn',
  succeeded: 'good',
  failed: 'bad',
  cancelled: 'muted'
}

const ACTIVE = new Set<MissionStatus>(['awaiting_approval', 'queued', 'running', 'verifying', 'paused', 'blocked'])

const selectClass =
  'h-8 w-full rounded-[3px] border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) px-2 text-xs text-foreground outline-none focus:border-primary'

function elapsed(seconds: number | null | undefined): string {
  if (seconds == null) {
    return '—'
  }

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60

  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

function runtimeLabel(value: string | null): string {
  if (!value) {
    return 'Benaiah is choosing'
  }

  return value === 'codex' ? 'Codex' : value === 'hermes' ? 'Hermes' : value
}

export function resolveMissionWorkspace(rawWorkspace: string) {
  const workspace = rawWorkspace.trim()

  return workspace
    ? { workspace_kind: 'dir' as const, workspace_path: workspace }
    : { workspace_kind: 'scratch' as const, workspace_path: null }
}

function MissionProgress({ mission }: { mission: Mission }) {
  const order = ['queued', 'running', 'verifying', 'succeeded']

  const current =
    mission.status === 'awaiting_approval' || mission.status === 'paused' || mission.status === 'blocked'
      ? -1
      : order.indexOf(mission.status)

  return (
    <div aria-label={`Mission status: ${STATUS_LABEL[mission.status]}`} className="flex items-center gap-1.5">
      {order.map((step, index) => (
        <span
          className={`h-1 flex-1 rounded-full ${index <= current ? 'bg-primary' : 'bg-(--ui-stroke-secondary)'}`}
          key={step}
        />
      ))}
    </div>
  )
}

function Receipt({ receipt }: { receipt: MissionReceipt }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-stroke-tertiary) sm:grid-cols-4">
      {[
        ['Duration', elapsed(receipt.duration_seconds)],
        ['Attempts', String(receipt.attempts)],
        ['Files changed', receipt.changed_file_count == null ? '—' : String(receipt.changed_file_count)],
        [
          'Cost observed',
          receipt.observed_cost_gbp == null ? 'Unavailable' : `£${receipt.observed_cost_gbp.toFixed(4)}`
        ]
      ].map(([label, value]) => (
        <div className="bg-(--ui-bg-secondary) px-3 py-2" key={label}>
          <div className="text-[0.625rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
          <div className="mt-1 text-xs font-medium text-foreground">{value}</div>
        </div>
      ))}
      {receipt.verifier_verdict?.summary && (
        <div className="col-span-2 bg-(--ui-bg-secondary) px-3 py-2 sm:col-span-4">
          <div className="text-[0.625rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Independent verdict
          </div>
          <p className="mt-1 text-xs leading-5 text-(--ui-text-secondary)">{receipt.verifier_verdict.summary}</p>
        </div>
      )}
    </div>
  )
}

function MissionCard({
  mission,
  onAction
}: {
  mission: Mission
  onAction: (action: string, id: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const busy = mission.status === 'running' || mission.status === 'verifying'

  return (
    <article className="rounded-lg border border-(--ui-stroke-tertiary) bg-[color-mix(in_srgb,var(--ui-bg-secondary)_82%,transparent)] p-4 shadow-[0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <StatusDot className={`mt-1.5 ${busy ? 'animate-pulse' : ''}`} tone={STATUS_TONE[mission.status]} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{mission.title}</h3>
            <Badge
              variant={
                mission.status === 'blocked' || mission.status === 'awaiting_approval'
                  ? 'warn'
                  : mission.status === 'failed'
                    ? 'destructive'
                    : mission.status === 'succeeded'
                      ? 'default'
                      : 'muted'
              }
            >
              {STATUS_LABEL[mission.status]}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-(--ui-text-secondary)">{mission.objective}</p>
          <div className="mt-3">
            <MissionProgress mission={mission} />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-muted-foreground">
            <span>{TIER_LABEL[mission.intelligence_tier]}</span>
            <span>
              {runtimeLabel(mission.selected_worker_runtime)} → {runtimeLabel(mission.selected_verifier_runtime)}
            </span>
            <span>
              {mission.current_attempt
                ? `Attempt ${mission.current_attempt}/${mission.max_retries + 1}`
                : 'Not started'}
            </span>
          </div>
          {mission.last_error && (
            <div className="mt-3 rounded border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[0.6875rem] leading-4 text-amber-700 dark:text-amber-200">
              {mission.last_error}
            </div>
          )}
          {expanded && (
            <div className="mt-3 border-t border-(--ui-stroke-tertiary) pt-3 text-xs">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-[0.625rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Success looks like
                  </div>
                  <p className="mt-1 leading-5 text-(--ui-text-secondary)">{mission.success_criteria}</p>
                </div>
                <div>
                  <div className="text-[0.625rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Workspace
                  </div>
                  <p className="mt-1 truncate font-mono text-[0.6875rem] leading-5 text-(--ui-text-secondary)">
                    {mission.workspace || 'Local managed workspace'}
                  </p>
                </div>
              </div>
              {mission.receipt && <Receipt receipt={mission.receipt} />}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-(--ui-stroke-tertiary) pt-3">
        <Button onClick={() => setExpanded(value => !value)} size="xs" variant="ghost">
          {expanded ? 'Hide details' : 'Details'}
        </Button>
        {mission.status === 'awaiting_approval' && (
          <Button onClick={() => void onAction('approve', mission.id)} size="xs">
            Approve full access
          </Button>
        )}
        {(mission.status === 'queued' || mission.status === 'running' || mission.status === 'verifying') && (
          <Button onClick={() => void onAction('pause', mission.id)} size="xs" variant="secondary">
            Pause
          </Button>
        )}
        {(mission.status === 'paused' || mission.status === 'blocked') && (
          <Button onClick={() => void onAction('resume', mission.id)} size="xs" variant="secondary">
            Resume
          </Button>
        )}
        {ACTIVE.has(mission.status) && (
          <Button onClick={() => void onAction('cancel', mission.id)} size="xs" variant="text">
            Cancel
          </Button>
        )}
      </div>
    </article>
  )
}

function CreateMission({ onCreated }: { onCreated: () => Promise<void> }) {
  const cwd = useValue(host.state.cwd)
  const [open, setOpen] = useState(false)
  const [objective, setObjective] = useState('')
  const [success, setSuccess] = useState('')
  const [workspace, setWorkspace] = useState(cwd)
  const [worker, setWorker] = useState('auto')
  const [tier, setTier] = useState('high')
  const [permission, setPermission] = useState('workspace_write')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!workspace && cwd) {
      setWorkspace(cwd)
    }
  }, [cwd, workspace])

  async function submit() {
    if (!objective.trim() || !success.trim()) {
      setError('Add the outcome and the evidence that proves it is finished.')

      return
    }

    if (worker === 'hermes' && permission === 'workspace_write') {
      setError(
        'Hermes does not yet have a workspace-only sandbox. Choose Benaiah, Codex, inspect only, or approved full access.'
      )

      return
    }

    setSaving(true)
    setError('')

    try {
      const resolvedWorkspace = resolveMissionWorkspace(workspace)

      await host.request('missions.create', {
        objective: objective.trim(),
        success_criteria: success.trim(),
        ...resolvedWorkspace,
        worker_runtime: worker,
        verifier_runtime: 'auto',
        intelligence_tier: tier,
        permission_mode: permission,
        max_runtime_seconds: 1800,
        max_retries: 1
      })
      setObjective('')
      setSuccess('')
      setOpen(false)
      await onCreated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Codicon name="add" /> New Mission
      </Button>
    )
  }

  return (
    <div className="w-full rounded-lg border border-primary/25 bg-[color-mix(in_srgb,var(--ui-bg-secondary)_88%,transparent)] p-4 shadow-lg backdrop-blur-xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Define the finish line</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Benaiah chooses, supervises and independently verifies the worker.
          </p>
        </div>
        <Button aria-label="Close Mission form" onClick={() => setOpen(false)} size="icon-xs" variant="ghost">
          <Codicon name="close" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[0.6875rem] font-medium text-(--ui-text-secondary)">
            What outcome do you want?
          </span>
          <Textarea
            onChange={event => setObjective(event.target.value)}
            placeholder="Prepare the release and leave it ready for my approval…"
            value={objective}
          />
        </label>
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[0.6875rem] font-medium text-(--ui-text-secondary)">
            What evidence proves it is finished?
          </span>
          <Textarea
            onChange={event => setSuccess(event.target.value)}
            placeholder="All checks pass, the changelog is accurate, and no uncommitted generated files remain…"
            value={success}
          />
        </label>
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[0.6875rem] font-medium text-(--ui-text-secondary)">
            Workspace <span className="font-normal text-muted-foreground">· optional</span>
          </span>
          <Input
            onChange={event => setWorkspace(event.target.value)}
            placeholder="Leave blank for a private Benaiah-managed workspace"
            value={workspace}
          />
          <p className="mt-1.5 text-[0.6875rem] leading-4 text-muted-foreground">
            Choose a folder for repository work. Otherwise Benaiah creates an isolated workspace automatically.
          </p>
        </label>
        <label>
          <span className="mb-1 block text-[0.6875rem] font-medium text-(--ui-text-secondary)">Worker</span>
          <select className={selectClass} onChange={event => setWorker(event.target.value)} value={worker}>
            <option value="auto">Benaiah chooses</option>
            <option value="codex">Codex</option>
            <option value="hermes">Hermes · read-only or full access</option>
          </select>
        </label>
        <label>
          <span className="mb-1 block text-[0.6875rem] font-medium text-(--ui-text-secondary)">Intelligence</span>
          <select className={selectClass} onChange={event => setTier(event.target.value)} value={tier}>
            {(['high', 'pro'] as const).map(value => (
              <option key={value} value={value}>
                {TIER_LABEL[value]}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[0.6875rem] leading-4 text-muted-foreground">
            Mission workers currently expose High and paid-only Pro. The full Auto ladder remains available in Benaiah
            Chat.
          </p>
        </label>
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[0.6875rem] font-medium text-(--ui-text-secondary)">Authority</span>
          <select className={selectClass} onChange={event => setPermission(event.target.value)} value={permission}>
            <option value="read_only">Inspect only</option>
            <option value="workspace_write">Work inside this workspace</option>
            <option value="full_access">Full computer access — approval required</option>
          </select>
          {permission === 'full_access' && (
            <p className="mt-1.5 text-[0.6875rem] leading-4 text-amber-700 dark:text-amber-200">
              The Mission will remain locked until you approve its full-access envelope.
            </p>
          )}
        </label>
      </div>
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => setOpen(false)} size="sm" variant="text">
          Cancel
        </Button>
        <Button disabled={saving} onClick={() => void submit()} size="sm">
          {saving ? 'Creating…' : permission === 'full_access' ? 'Create locked Mission' : 'Start Mission'}
        </Button>
      </div>
    </div>
  )
}

function MissionsPage() {
  const gateway = useValue(host.state.gateway)
  const [missions, setMissions] = useState<Mission[] | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (gateway !== 'open') {
      return
    }

    try {
      const result = await host.request<{ missions: Mission[] }>('missions.list', { limit: 200 })
      setMissions(result.missions)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [gateway])

  useEffect(() => {
    void refresh()

    if (gateway !== 'open') {
      return
    }

    const timer = window.setInterval(() => void refresh(), 3_000)

    return () => window.clearInterval(timer)
  }, [gateway, refresh])

  async function action(name: string, id: string) {
    try {
      await host.request(`missions.${name}`, { mission_id: id })
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const groups = useMemo(
    () => ({
      active: missions?.filter(mission => ACTIVE.has(mission.status)) ?? [],
      complete: missions?.filter(mission => !ACTIVE.has(mission.status)) ?? []
    }),
    [missions]
  )

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-(--ui-editor-surface-background)">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-7 sm:py-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-primary">
              <Codicon name="rocket" size={18} />
              <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em]">Agent Control Plane</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Missions</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-(--ui-text-secondary)">
              Tell Benaiah what finished looks like. It assigns the right worker, holds the authority boundary, verifies
              the outcome and leaves a receipt.
            </p>
          </div>
          <CreateMission onCreated={refresh} />
        </header>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <Codicon className="mt-0.5" name="error" /> {error}
          </div>
        )}

        {missions === null ? (
          <div className="flex min-h-48 items-center justify-center text-xs text-muted-foreground">
            Loading Missions…
          </div>
        ) : missions.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-(--ui-stroke-secondary) px-6 text-center">
            <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Codicon name="rocket" size={21} />
            </div>
            <h2 className="text-sm font-semibold text-foreground">Give Benaiah an outcome</h2>
            <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
              Your first Mission will be supervised from intent through independent verification.
            </p>
          </div>
        ) : (
          <>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Active</h2>
                <span className="text-[0.6875rem] text-muted-foreground">{groups.active.length}</span>
              </div>
              <div className="grid gap-3">
                {groups.active.map(mission => (
                  <MissionCard key={mission.id} mission={mission} onAction={action} />
                ))}
              </div>
              {groups.active.length === 0 && (
                <p className="rounded-md border border-dashed border-(--ui-stroke-tertiary) py-5 text-center text-xs text-muted-foreground">
                  No active Missions.
                </p>
              )}
            </section>
            {groups.complete.length > 0 && (
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">History</h2>
                  <span className="text-[0.6875rem] text-muted-foreground">{groups.complete.length}</span>
                </div>
                <div className="grid gap-3">
                  {groups.complete.map(mission => (
                    <MissionCard key={mission.id} mission={mission} onAction={action} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  )
}

const plugin: HermesPlugin = {
  id: 'missions',
  name: 'Benaiah Missions',
  defaultEnabled: true,
  register(ctx) {
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        title: 'Missions',
        data: { path: '/missions' },
        render: () => <MissionsPage />
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 35,
        data: { codicon: 'rocket', label: 'Missions', path: '/missions' }
      }
    ])
  }
}

export default plugin
