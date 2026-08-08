"""Durable Benaiah Mission contracts built on the Kanban execution kernel.

Mission rows hold operator intent, authority, budgets, verification policy and
the final Action Receipt.  The associated Kanban task remains authoritative
for dispatch, claims, workspaces, heartbeats and crash recovery.
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from hermes_cli import kanban_db as kb


MISSION_STATUSES = {
    "awaiting_approval",
    "queued",
    "running",
    "verifying",
    "paused",
    "blocked",
    "succeeded",
    "failed",
    "cancelled",
}
TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}
WORKER_RUNTIMES = {"auto", "codex", "hermes"}
VERIFIER_RUNTIMES = {"auto", "none", "codex", "hermes"}
PERMISSION_MODES = {"read_only", "workspace_write", "full_access"}
INTELLIGENCE_TIERS = {"instant", "medium", "high", "extra_high", "pro"}

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS missions (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL UNIQUE REFERENCES tasks(id),
    title                   TEXT NOT NULL,
    objective               TEXT NOT NULL,
    success_criteria        TEXT NOT NULL,
    status                  TEXT NOT NULL,
    worker_runtime          TEXT NOT NULL DEFAULT 'auto',
    selected_worker_runtime TEXT,
    worker_profile          TEXT NOT NULL,
    verifier_runtime        TEXT NOT NULL DEFAULT 'auto',
    selected_verifier_runtime TEXT,
    intelligence_tier       TEXT NOT NULL DEFAULT 'high',
    permission_mode         TEXT NOT NULL DEFAULT 'workspace_write',
    allowed_tools_json      TEXT NOT NULL DEFAULT '[]',
    verification_commands_json TEXT NOT NULL DEFAULT '[]',
    max_runtime_seconds     INTEGER NOT NULL DEFAULT 1800,
    max_retries             INTEGER NOT NULL DEFAULT 1,
    max_cost_gbp_micros     INTEGER,
    created_by              TEXT,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL,
    started_at              INTEGER,
    completed_at            INTEGER,
    approved_at             INTEGER,
    current_phase           TEXT,
    current_attempt         INTEGER NOT NULL DEFAULT 0,
    last_error              TEXT,
    receipt_json            TEXT,
    CHECK (status IN ('awaiting_approval','queued','running','verifying','paused','blocked','succeeded','failed','cancelled')),
    CHECK (worker_runtime IN ('auto','codex','hermes')),
    CHECK (verifier_runtime IN ('auto','none','codex','hermes')),
    CHECK (permission_mode IN ('read_only','workspace_write','full_access')),
    CHECK (intelligence_tier IN ('instant','medium','high','extra_high','pro'))
);

CREATE INDEX IF NOT EXISTS idx_missions_status_created
    ON missions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS mission_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id  TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    payload_json TEXT,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mission_events_mission_id
    ON mission_events(mission_id, id);

CREATE TABLE IF NOT EXISTS mission_attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id      TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    runtime         TEXT NOT NULL,
    attempt_number  INTEGER NOT NULL,
    status          TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    pid             INTEGER,
    exit_code       INTEGER,
    summary         TEXT,
    evidence_json   TEXT,
    metadata_json   TEXT
);

CREATE INDEX IF NOT EXISTS idx_mission_attempts_mission_id
    ON mission_attempts(mission_id, id);
"""


@dataclass(frozen=True)
class Mission:
    id: str
    task_id: str
    title: str
    objective: str
    success_criteria: str
    status: str
    worker_runtime: str
    selected_worker_runtime: Optional[str]
    worker_profile: str
    verifier_runtime: str
    selected_verifier_runtime: Optional[str]
    intelligence_tier: str
    permission_mode: str
    allowed_tools: list[str]
    verification_commands: list[str]
    max_runtime_seconds: int
    max_retries: int
    max_cost_gbp_micros: Optional[int]
    created_by: Optional[str]
    created_at: int
    updated_at: int
    started_at: Optional[int]
    completed_at: Optional[int]
    approved_at: Optional[int]
    current_phase: Optional[str]
    current_attempt: int
    last_error: Optional[str]
    receipt: Optional[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Install the additive Mission schema in an existing Kanban database."""
    conn.executescript(SCHEMA_SQL)


def _json_list(raw: Any) -> list[str]:
    try:
        parsed = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [str(value) for value in parsed if value] if isinstance(parsed, list) else []


def _json_object(raw: Any) -> Optional[dict[str, Any]]:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _from_row(row: sqlite3.Row) -> Mission:
    return Mission(
        id=row["id"],
        task_id=row["task_id"],
        title=row["title"],
        objective=row["objective"],
        success_criteria=row["success_criteria"],
        status=row["status"],
        worker_runtime=row["worker_runtime"],
        selected_worker_runtime=row["selected_worker_runtime"],
        worker_profile=row["worker_profile"],
        verifier_runtime=row["verifier_runtime"],
        selected_verifier_runtime=row["selected_verifier_runtime"],
        intelligence_tier=row["intelligence_tier"],
        permission_mode=row["permission_mode"],
        allowed_tools=_json_list(row["allowed_tools_json"]),
        verification_commands=_json_list(row["verification_commands_json"]),
        max_runtime_seconds=int(row["max_runtime_seconds"]),
        max_retries=int(row["max_retries"]),
        max_cost_gbp_micros=row["max_cost_gbp_micros"],
        created_by=row["created_by"],
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
        started_at=row["started_at"],
        completed_at=row["completed_at"],
        approved_at=row["approved_at"],
        current_phase=row["current_phase"],
        current_attempt=int(row["current_attempt"]),
        last_error=row["last_error"],
        receipt=_json_object(row["receipt_json"]),
    )


def _event(
    conn: sqlite3.Connection,
    mission_id: str,
    kind: str,
    payload: Optional[dict[str, Any]] = None,
) -> None:
    conn.execute(
        "INSERT INTO mission_events (mission_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
        (
            mission_id,
            kind,
            json.dumps(payload, separators=(",", ":"), sort_keys=True)
            if payload
            else None,
            int(time.time()),
        ),
    )


def _validate_choice(value: str, choices: set[str], name: str) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_")
    if normalized not in choices:
        raise ValueError(f"{name} must be one of {sorted(choices)}")
    return normalized


def _default_profile() -> str:
    from hermes_cli.profiles import get_active_profile_name

    profile = get_active_profile_name()
    return "default" if profile == "custom" else profile


def create_mission(
    conn: sqlite3.Connection,
    *,
    objective: str,
    success_criteria: str,
    title: Optional[str] = None,
    worker_runtime: str = "auto",
    verifier_runtime: str = "auto",
    worker_profile: Optional[str] = None,
    intelligence_tier: str = "high",
    permission_mode: str = "workspace_write",
    allowed_tools: Iterable[str] = (),
    verification_commands: Iterable[str] = (),
    workspace_kind: str = "dir",
    workspace_path: Optional[str] = None,
    max_runtime_seconds: int = 1800,
    max_retries: int = 1,
    max_cost_gbp_micros: Optional[int] = None,
    created_by: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    approve_now: bool = False,
    board: Optional[str] = None,
) -> Mission:
    """Create a durable Mission and its dispatch task."""
    ensure_schema(conn)
    objective = str(objective or "").strip()
    success_criteria = str(success_criteria or "").strip()
    if not objective:
        raise ValueError("objective is required")
    if not success_criteria:
        raise ValueError("success_criteria is required")
    worker_runtime = _validate_choice(worker_runtime, WORKER_RUNTIMES, "worker_runtime")
    verifier_runtime = _validate_choice(
        verifier_runtime, VERIFIER_RUNTIMES, "verifier_runtime"
    )
    intelligence_tier = _validate_choice(
        intelligence_tier, INTELLIGENCE_TIERS, "intelligence_tier"
    )
    permission_mode = _validate_choice(
        permission_mode, PERMISSION_MODES, "permission_mode"
    )
    if worker_runtime == "hermes" and permission_mode == "workspace_write":
        raise ValueError(
            "Hermes cannot yet enforce workspace-only writes; choose Codex, "
            "read-only, or explicitly approved full access"
        )
    if max_runtime_seconds < 1:
        raise ValueError("max_runtime_seconds must be positive")
    if max_retries < 0:
        raise ValueError("max_retries cannot be negative")
    if max_cost_gbp_micros is not None and max_cost_gbp_micros < 0:
        raise ValueError("max_cost_gbp_micros cannot be negative")

    if workspace_path:
        workspace_path = str(Path(workspace_path).expanduser().resolve())
    profile = worker_profile or _default_profile()
    mission_id = "m_" + secrets.token_hex(8)
    mission_title = (title or objective.splitlines()[0])[:160].strip()
    needs_approval = permission_mode == "full_access" and not approve_now
    task_id = kb.create_task(
        conn,
        title=f"Mission: {mission_title}",
        body="Benaiah Mission control task. Mission content is stored locally in the Mission contract.",
        assignee=profile,
        created_by=created_by or "benaiah-missions",
        workspace_kind=workspace_kind,
        workspace_path=workspace_path,
        idempotency_key=(f"mission:{idempotency_key}" if idempotency_key else None),
        max_runtime_seconds=int(max_runtime_seconds),
        max_retries=max(1, int(max_retries) + 1),
        initial_status="blocked" if needs_approval else "running",
        board=board,
    )
    existing = conn.execute(
        "SELECT * FROM missions WHERE task_id = ?", (task_id,)
    ).fetchone()
    if existing:
        return _from_row(existing)

    now = int(time.time())
    status = "awaiting_approval" if needs_approval else "queued"
    approved_at = now if permission_mode == "full_access" and approve_now else None
    try:
        with kb.write_txn(conn):
            conn.execute(
                """
                INSERT INTO missions (
                    id, task_id, title, objective, success_criteria, status,
                    worker_runtime, worker_profile, verifier_runtime,
                    intelligence_tier, permission_mode, allowed_tools_json,
                    verification_commands_json, max_runtime_seconds, max_retries,
                    max_cost_gbp_micros, created_by, created_at, updated_at, approved_at,
                    current_phase
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mission_id,
                    task_id,
                    mission_title,
                    objective,
                    success_criteria,
                    status,
                    worker_runtime,
                    profile,
                    verifier_runtime,
                    intelligence_tier,
                    permission_mode,
                    json.dumps(list(allowed_tools)),
                    json.dumps(list(verification_commands)),
                    int(max_runtime_seconds),
                    int(max_retries),
                    max_cost_gbp_micros,
                    created_by,
                    now,
                    now,
                    approved_at,
                    "approval" if needs_approval else "dispatch",
                ),
            )
            _event(
                conn,
                mission_id,
                "created",
                {
                    "permission_mode": permission_mode,
                    "worker_runtime": worker_runtime,
                    "verifier_runtime": verifier_runtime,
                    "intelligence_tier": intelligence_tier,
                },
            )
    except Exception:
        kb.archive_task(conn, task_id)
        raise
    return get_mission(conn, mission_id)


def get_mission(conn: sqlite3.Connection, mission_id: str) -> Mission:
    ensure_schema(conn)
    row = conn.execute(
        "SELECT * FROM missions WHERE id = ? OR task_id = ?", (mission_id, mission_id)
    ).fetchone()
    if not row:
        raise KeyError(f"unknown mission: {mission_id}")
    _reconcile_row(conn, row)
    row = conn.execute("SELECT * FROM missions WHERE id = ?", (row["id"],)).fetchone()
    return _from_row(row)


def _reconcile_row(conn: sqlite3.Connection, row: sqlite3.Row) -> None:
    """Repair Mission display state from its authoritative Kanban task."""
    current = str(row["status"])
    if current in TERMINAL_STATUSES:
        return
    task = kb.get_task(conn, row["task_id"])
    if task is None:
        target, phase, error = "failed", "terminal", "Mission task is missing"
    elif task.status == "archived":
        target, phase, error = "cancelled", "terminal", None
    elif current == "awaiting_approval":
        return
    elif current == "paused" and task.status == "scheduled":
        return
    elif task.status in {"blocked", "triage"}:
        target, phase, error = "blocked", "blocked", task.last_failure_error
    elif task.status == "scheduled":
        target, phase, error = "paused", "paused", None
    elif task.status in {"ready", "todo"} and current in {"running", "verifying"}:
        target, phase, error = (
            "queued",
            "dispatch",
            "Previous supervisor stopped before completion",
        )
    elif task.status == "running" and current == "queued":
        target, phase, error = "running", "primary", None
    elif task.status == "done" and current != "succeeded":
        target, phase, error = (
            "failed",
            "terminal",
            "Task completed without a Mission Action Receipt",
        )
    else:
        return
    if target == current and (not error or row["last_error"] == error):
        return
    now = int(time.time())
    with kb.write_txn(conn):
        values: list[Any] = [target, phase, now, error, row["id"]]
        terminal = (
            ", completed_at=COALESCE(completed_at, ?)"
            if target in TERMINAL_STATUSES
            else ""
        )
        if terminal:
            values.insert(-1, now)
        conn.execute(
            f"UPDATE missions SET status=?, current_phase=?, updated_at=?, last_error=?{terminal} WHERE id=?",
            values,
        )
        _event(
            conn,
            row["id"],
            "reconciled",
            {
                "from": current,
                "to": target,
                "task_status": task.status if task else "missing",
            },
        )


def list_missions(
    conn: sqlite3.Connection,
    *,
    status: Optional[str] = None,
    include_terminal: bool = True,
    limit: int = 100,
) -> list[Mission]:
    ensure_schema(conn)
    for stale in conn.execute(
        "SELECT * FROM missions WHERE status NOT IN ('succeeded','failed','cancelled')"
    ).fetchall():
        _reconcile_row(conn, stale)
    params: list[Any] = []
    query = "SELECT * FROM missions WHERE 1=1"
    if status:
        status = _validate_choice(status, MISSION_STATUSES, "status")
        query += " AND status = ?"
        params.append(status)
    elif not include_terminal:
        query += " AND status NOT IN ('succeeded','failed','cancelled')"
    query += " ORDER BY created_at DESC, id DESC LIMIT ?"
    params.append(max(1, min(int(limit), 1000)))
    return [_from_row(row) for row in conn.execute(query, params).fetchall()]


def events(
    conn: sqlite3.Connection, mission_id: str, *, limit: int = 200
) -> list[dict[str, Any]]:
    mission = get_mission(conn, mission_id)
    rows = conn.execute(
        "SELECT * FROM mission_events WHERE mission_id = ? ORDER BY id DESC LIMIT ?",
        (mission.id, max(1, min(int(limit), 1000))),
    ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "mission_id": row["mission_id"],
            "kind": row["kind"],
            "payload": _json_object(row["payload_json"]),
            "created_at": int(row["created_at"]),
        }
        for row in reversed(rows)
    ]


def attempts(conn: sqlite3.Connection, mission_id: str) -> list[dict[str, Any]]:
    mission = get_mission(conn, mission_id)
    rows = conn.execute(
        "SELECT * FROM mission_attempts WHERE mission_id = ? ORDER BY id", (mission.id,)
    ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "mission_id": row["mission_id"],
            "role": row["role"],
            "runtime": row["runtime"],
            "attempt_number": int(row["attempt_number"]),
            "status": row["status"],
            "started_at": int(row["started_at"]),
            "ended_at": row["ended_at"],
            "pid": row["pid"],
            "exit_code": row["exit_code"],
            "summary": row["summary"],
            "evidence": _json_object(row["evidence_json"]),
            "metadata": _json_object(row["metadata_json"]),
        }
        for row in rows
    ]


def approve_mission(conn: sqlite3.Connection, mission_id: str) -> Mission:
    mission = get_mission(conn, mission_id)
    if mission.permission_mode != "full_access":
        raise ValueError("only full_access Missions require approval")
    if mission.status != "awaiting_approval":
        raise ValueError(f"Mission is {mission.status}, not awaiting approval")
    now = int(time.time())
    with kb.write_txn(conn):
        conn.execute(
            "UPDATE missions SET status='queued', approved_at=?, updated_at=?, current_phase='dispatch' WHERE id=?",
            (now, now, mission.id),
        )
        _event(conn, mission.id, "approved", {"permission_mode": "full_access"})
    if not kb.unblock_task(conn, mission.task_id):
        _mark_blocked(
            conn, mission.id, "Mission task could not be released after approval"
        )
    return get_mission(conn, mission.id)


def pause_mission(conn: sqlite3.Connection, mission_id: str) -> Mission:
    mission = get_mission(conn, mission_id)
    if mission.status in TERMINAL_STATUSES:
        raise ValueError(f"cannot pause a {mission.status} Mission")
    if mission.status == "awaiting_approval":
        raise ValueError("Mission is already held pending approval")
    task = kb.get_task(conn, mission.task_id)
    if task and task.status == "running":
        kb.reclaim_task(conn, mission.task_id, reason="Mission paused by operator")
    task = kb.get_task(conn, mission.task_id)
    if task and task.status in {"ready", "running", "blocked", "todo"}:
        kb.schedule_task(conn, mission.task_id, reason="Mission paused by operator")
    now = int(time.time())
    with kb.write_txn(conn):
        conn.execute(
            "UPDATE missions SET status='paused', updated_at=?, current_phase='paused' WHERE id=?",
            (now, mission.id),
        )
        _event(conn, mission.id, "paused")
    return get_mission(conn, mission.id)


def resume_mission(conn: sqlite3.Connection, mission_id: str) -> Mission:
    mission = get_mission(conn, mission_id)
    if mission.status not in {"paused", "blocked"}:
        raise ValueError(f"cannot resume a {mission.status} Mission")
    if mission.permission_mode == "full_access" and mission.approved_at is None:
        raise ValueError("full_access Mission requires approval before resume")
    if not kb.unblock_task(conn, mission.task_id):
        raise RuntimeError("Mission task could not be resumed")
    now = int(time.time())
    with kb.write_txn(conn):
        conn.execute(
            "UPDATE missions SET status='queued', updated_at=?, current_phase='dispatch', last_error=NULL WHERE id=?",
            (now, mission.id),
        )
        _event(conn, mission.id, "resumed")
    return get_mission(conn, mission.id)


def cancel_mission(conn: sqlite3.Connection, mission_id: str) -> Mission:
    mission = get_mission(conn, mission_id)
    if mission.status in TERMINAL_STATUSES:
        return mission
    task = kb.get_task(conn, mission.task_id)
    if task and task.status == "running":
        kb.reclaim_task(conn, mission.task_id, reason="Mission cancelled by operator")
    kb.archive_task(conn, mission.task_id)
    now = int(time.time())
    receipt = _control_receipt(mission, "cancelled", now)
    with kb.write_txn(conn):
        conn.execute(
            "UPDATE missions SET status='cancelled', completed_at=?, updated_at=?, current_phase='terminal', receipt_json=? WHERE id=?",
            (
                now,
                now,
                json.dumps(receipt, separators=(",", ":"), sort_keys=True),
                mission.id,
            ),
        )
        _event(conn, mission.id, "cancelled")
    return get_mission(conn, mission.id)


def _control_receipt(
    mission: Mission, status: str, completed_at: int
) -> dict[str, Any]:
    return {
        "mission_id": mission.id,
        "task_id": mission.task_id,
        "status": status,
        "worker": mission.selected_worker_runtime,
        "verifier": mission.selected_verifier_runtime,
        "started_at": mission.started_at,
        "completed_at": completed_at,
        "duration_seconds": max(0, completed_at - mission.started_at)
        if mission.started_at
        else None,
        "attempts": mission.current_attempt,
        "retries": max(0, mission.current_attempt - 1),
        "checks": [],
        "verifier_verdict": None,
        "changed_file_count": None,
        "observed_cost_gbp": None,
        "worktree_available": False,
        "requested_intelligence_tier": mission.intelligence_tier,
        "effective_managed_cli_tier": "pro"
        if mission.intelligence_tier == "pro"
        else "high",
    }


def _mark_blocked(conn: sqlite3.Connection, mission_id: str, reason: str) -> None:
    now = int(time.time())
    with kb.write_txn(conn):
        conn.execute(
            "UPDATE missions SET status='blocked', updated_at=?, current_phase='blocked', last_error=? WHERE id=?",
            (now, reason[:1000], mission_id),
        )
        _event(conn, mission_id, "blocked", {"reason": reason[:500]})


def receipt(conn: sqlite3.Connection, mission_id: str) -> Optional[dict[str, Any]]:
    return get_mission(conn, mission_id).receipt


def maybe_spawn_task(
    task: kb.Task, workspace: str, *, board: Optional[str] = None
) -> Optional[int]:
    """Spawn the Mission supervisor when ``task`` belongs to a Mission."""
    with kb.connect_closing(board=board) as conn:
        ensure_schema(conn)
        row = conn.execute(
            "SELECT id, status FROM missions WHERE task_id = ?", (task.id,)
        ).fetchone()
    if row is None:
        return None
    if row["status"] not in {"queued", "running"}:
        raise RuntimeError(f"Mission {row['id']} is not dispatchable ({row['status']})")
    env = dict(os.environ)
    env["HERMES_KANBAN_DB"] = str(kb.kanban_db_path(board=board))
    env["HERMES_KANBAN_WORKSPACES_ROOT"] = str(kb.workspaces_root(board=board))
    env["HERMES_KANBAN_BOARD"] = (
        kb._normalize_board_slug(board) or kb.get_current_board()
    )
    if workspace and os.path.isabs(workspace) and os.path.isdir(workspace):
        env["TERMINAL_CWD"] = workspace
    if task.current_run_id is not None:
        env["HERMES_KANBAN_RUN_ID"] = str(task.current_run_id)
    if task.claim_lock:
        env["HERMES_KANBAN_CLAIM_LOCK"] = task.claim_lock
    command = [
        sys.executable,
        "-m",
        "hermes_cli.mission_worker",
        "--mission",
        row["id"],
        "--workspace",
        workspace,
        "--board",
        env["HERMES_KANBAN_BOARD"],
    ]
    log_dir = kb.worker_logs_dir(board=board)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_handle = open(log_dir / f"{task.id}.mission.log", "ab")
    try:
        process = subprocess.Popen(
            command,
            cwd=workspace if os.path.isdir(workspace) else None,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    except Exception:
        log_handle.close()
        raise
    return process.pid
