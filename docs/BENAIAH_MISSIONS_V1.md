# Benaiah Missions v1

Missions are persistent outcome contracts supervised by Benaiah. They are not
another chat surface and they are not a second scheduler. The existing Kanban
kernel remains authoritative for durable dispatch, atomic claims, workspaces,
heartbeats, retries, crash recovery, logs, attachments and task history.

## Product contract

A Mission answers seven questions before work starts:

1. What outcome is required?
2. What evidence proves success?
3. Which worker should attempt it?
4. Which workspace and tools may it use?
5. What time, retry and intelligence budget applies?
6. Does the permission envelope require operator approval?
7. Which independent worker verifies the result?

The primary worker never certifies its own success. Benaiah records the worker
result, runs deterministic checks when configured, asks an independent verifier
when enabled, and only then emits a successful Action Receipt.

## Authority and storage

- The local agent backend owns Mission truth.
- Mission rows and events live in the active Kanban SQLite database so task and
  Mission transitions share one durable local boundary.
- The Desktop renderer, Benaiah Bar and CLI are views/controllers of that truth.
- The Outcome Ledger receives bounded lifecycle metadata only. Mission
  objectives, worker output, commands, paths and file contents stay local.

## Lifecycle

`awaiting_approval -> queued -> running -> verifying -> succeeded`

Alternate terminal/control states are `paused`, `blocked`, `failed` and
`cancelled`. Resume returns a paused Mission to `queued`. A blocked Mission
requires explicit operator intervention; it never hot-loops indefinitely.

## Worker adapters

v1 ships two real adapters:

- `codex`: non-interactive Codex execution with JSONL events and an explicit
  sandbox rooted at the Mission workspace.
- `hermes`: quiet Hermes execution with a task-scoped toolset.

Adapter precedence is structured/native CLI first. Computer control is reserved
for future workers that expose no dependable machine interface.

`auto` routing is deterministic in v1. Workspace-write Missions use Codex
because its native sandbox can enforce the promised directory boundary.
Read-only and explicitly approved full-access Missions may prefer Hermes for
non-code work. An explicit Hermes + workspace-write request fails closed until
Hermes exposes an equivalent boundary. The selected runtime is persisted on
the attempt and never silently changes mid-attempt.

## Permission modes

- `read_only`: inspection only.
- `workspace_write`: may edit only inside the selected workspace; default.
- `full_access`: may escape the workspace sandbox and bypass worker prompts.
  It is never dispatched until the operator explicitly approves the Mission.

The allowlisted Hermes toolsets are fixed for the whole worker process so prompt
caching is not invalidated mid-session. Codex uses its native sandbox boundary.
Deterministic verification commands are explicit operator-authored CLI inputs;
they are never accepted from worker output and are not exposed by the Desktop
form. They execute locally with the operator's authority after the worker exits.

## Budgets

v1 enforces wall-clock runtime and bounded attempts. It records the requested
Benaiah intelligence tier. The current managed CLI gateways enforce High and
paid-only Pro; other stored Auto targets resolve to High until those gateways
expose the full five-tier contract. Receipts state both requested and effective
tier, while Outcome Ledger routing metadata records the effective tier. A GBP
ceiling may be stored as intent, but is reported as unavailable
until provider cost can be reconciled to the Mission run; the Control Plane
must never fabricate spend or claim enforcement it cannot prove.

## Workspace ownership

One primary worker holds the write lease. The verifier runs only after that
worker exits and is read-only. Coding Missions should use a Kanban-managed git
worktree; directory Missions use an explicit absolute path. Scratch workspaces
retain Kanban's existing artifact-preservation rules.

## Action Receipt

A terminal receipt includes:

- Mission and task identifiers
- selected worker and verifier
- started/completed timestamps and duration
- attempt and retry counts
- deterministic checks and verifier verdict
- changed-file count when observable
- final status and concise evidence
- observed cost, or `null` when unavailable
- whether the worktree remains available for inspection

## v1 non-goals

- Parallel writers in one workspace
- GUI screen-scraping when a CLI interface exists
- Automatic production deploys or external sends without explicit authority
- Learning-based routing before a clean Outcome Ledger baseline exists
- Pretending model-call success is equivalent to a verified Mission outcome
