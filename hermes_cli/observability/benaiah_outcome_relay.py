"""Privacy-safe, durable Outcome Ledger relay for managed Benaiah Desktop."""

from __future__ import annotations

import json
import logging
import os
import platform as platform_module
import random
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hermes_cli import __version__

logger = logging.getLogger(__name__)

HANDLED_HOOKS = frozenset({
    "pre_api_request", "post_api_request", "api_request_error",
    "pre_tool_call", "post_tool_call",
})
_LOCK = threading.RLock()
_WORKER: threading.Thread | None = None
_TASKS: dict[str, dict[str, Any]] = {}
_MODEL_CALLS: dict[str, tuple[str, float]] = {}
_TOOL_CALLS: dict[str, tuple[str, float]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _platform() -> str:
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform.startswith("linux"):
        return "linux"
    return "unknown"


def _home() -> Path:
    raw = os.environ.get("HERMES_HOME", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".hermes"


def _database_path() -> Path:
    path = _home() / "telemetry" / "benaiah_outcomes" / "relay.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _connection() -> sqlite3.Connection:
    connection = sqlite3.connect(_database_path(), timeout=5)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS outbox (
          envelope_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt REAL NOT NULL DEFAULT 0,
          created_at REAL NOT NULL
        )
        """
    )
    connection.execute("DELETE FROM outbox WHERE created_at < ?", (time.time() - 30 * 86400,))
    connection.commit()
    return connection


def _credentials() -> tuple[str, str] | None:
    try:
        from hermes_cli.config import read_raw_config_readonly

        config = read_raw_config_readonly() or {}
    except Exception:
        return None
    model = config.get("model") if isinstance(config, dict) else None
    if not isinstance(model, dict):
        return None
    base_url = str(model.get("base_url") or "").strip().rstrip("/")
    token = str(model.get("api_key") or "").strip()
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "https" or parsed.hostname not in {"benaiah.ai", "www.benaiah.ai"}:
        return None
    if not parsed.path.rstrip("/").endswith("/api/cli/v1/desktop"):
        return None
    if not token.startswith("bna_guest_"):
        return None
    endpoint = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, "/api/cli/v1/outcomes", "", "", ""))
    return endpoint, token


def enabled() -> bool:
    return _credentials() is not None


def handles_hook(hook_name: str) -> bool:
    return hook_name in HANDLED_HOOKS and enabled()


def _enqueue(envelope: dict[str, Any]) -> None:
    if not enabled():
        return
    envelope_id = str(envelope.pop("_envelope_id", "") or uuid.uuid4())
    payload = json.dumps(envelope, separators=(",", ":"), sort_keys=True)
    # Leakage tripwire: the native contract never contains these content-bearing keys.
    forbidden = {"prompt", "response", "content", "command", "args", "path", "url", "error_message"}
    if forbidden.intersection(envelope.get("input", {})):
        logger.warning("Blocked content-bearing Benaiah outcome envelope")
        return
    with _connection() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO outbox (envelope_id, payload, created_at) VALUES (?, ?, ?)",
            (envelope_id, payload, time.time()),
        )
    _start_worker()


def _start_worker() -> None:
    global _WORKER
    with _LOCK:
        if _WORKER is not None and _WORKER.is_alive():
            return
        _WORKER = threading.Thread(target=_drain, name="benaiah-outcome-relay", daemon=True)
        _WORKER.start()


def _drain() -> None:
    while True:
        credentials = _credentials()
        if credentials is None:
            return
        with _connection() as connection:
            row = connection.execute(
                "SELECT envelope_id, payload, attempts FROM outbox WHERE next_attempt <= ? ORDER BY created_at LIMIT 1",
                (time.time(),),
            ).fetchone()
        if row is None:
            return
        envelope_id, payload, attempts = row
        endpoint, token = credentials
        request = urllib.request.Request(
            endpoint,
            data=payload.encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": f"BenaiahDesktop/{__version__} ({platform_module.system()})",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                accepted = 200 <= int(response.status) < 300
        except Exception:
            accepted = False
        with _connection() as connection:
            if accepted:
                connection.execute("DELETE FROM outbox WHERE envelope_id = ?", (envelope_id,))
            else:
                next_attempts = int(attempts) + 1
                delay = min(3600.0, (2 ** min(next_attempts, 10)) + random.random() * 3)
                connection.execute(
                    "UPDATE outbox SET attempts = ?, next_attempt = ? WHERE envelope_id = ?",
                    (next_attempts, time.time() + delay, envelope_id),
                )
                return


def _base_input() -> dict[str, Any]:
    return {
        "clientPlatform": _platform(),
        "clientVersion": __version__,
    }


def _heartbeat() -> None:
    bucket = int(time.time() // 3600)
    _enqueue({
        "_envelope_id": f"heartbeat:{_platform()}:{__version__}:{bucket}",
        "kind": "heartbeat",
        "input": {
            **_base_input(),
            "heartbeatId": f"{_platform()}:{__version__}:{bucket}",
            "occurredAt": _now(),
        },
    })


def start_task_run(
    *, session_id: str, task_id: str, platform: str, parent_session_id: str = "",
    feature: str = "managed_intelligence", task_class: str = "agent_request",
    auto_tier: str = "high",
) -> None:
    del session_id, parent_session_id
    if not enabled() or not task_id:
        return
    started_at = _now()
    with _LOCK:
        _TASKS[task_id] = {
            "started_at": started_at,
            "started_monotonic": time.monotonic(),
            "tool_calls": set(),
            "tool_successes": 0,
            "tool_failures": 0,
            "model_calls": set(),
            "retry_count": 0,
            "execution_platform": str(platform or ""),
            "feature": str(feature or "managed_intelligence"),
            "task_class": str(task_class or "agent_request"),
            "auto_tier": str(auto_tier or "high"),
        }
    _heartbeat()
    _enqueue({
        "_envelope_id": f"run:{task_id}:started",
        "kind": "run",
        "sourceId": task_id,
        "input": {
            **_base_input(),
            "feature": str(feature or "managed_intelligence"),
            "taskClass": str(task_class or "agent_request"),
            "routeMode": "auto",
            "autoTier": str(auto_tier or "high"),
            "status": "started",
            "startedAt": started_at,
            "occurredAt": started_at,
            "eventId": f"run:{task_id}:started",
        },
    })


def finish_task_run(
    *, session_id: str, task_id: str, platform: str,
    result: dict[str, Any] | None = None, error: BaseException | None = None,
    feature: str | None = None, task_class: str | None = None,
    auto_tier: str | None = None,
) -> None:
    del session_id, platform
    if not enabled() or not task_id:
        return
    terminal = result if isinstance(result, dict) else {}
    interrupted = terminal.get("interrupted") is True or isinstance(error, (KeyboardInterrupt, InterruptedError))
    failed = error is not None or terminal.get("failed") is True
    status = "cancelled" if interrupted else "failed" if failed else "completed"
    reason = "task_error" if failed else ""
    completed_at = _now()
    with _LOCK:
        task = _TASKS.pop(task_id, None) or {}
    started_at = str(task.get("started_at") or completed_at)
    duration_ms = max(0, int((time.monotonic() - float(task.get("started_monotonic", time.monotonic()))) * 1000))
    _enqueue({
        "_envelope_id": f"run:{task_id}:{status}",
        "kind": "run",
        "sourceId": task_id,
        "input": {
            **_base_input(),
            "feature": str(feature or task.get("feature") or "managed_intelligence"),
            "taskClass": str(task_class or task.get("task_class") or "agent_request"),
            "routeMode": "auto",
            "autoTier": str(auto_tier or task.get("auto_tier") or "high"),
            "status": status,
            "statusReason": reason,
            "startedAt": started_at,
            "completedAt": completed_at,
            "occurredAt": completed_at,
            "durationMs": duration_ms,
            "toolCalls": len(task.get("tool_calls", set())),
            "toolSuccesses": int(task.get("tool_successes", 0)),
            "toolFailures": int(task.get("tool_failures", 0)),
            "retryCount": int(task.get("retry_count", 0)),
            "eventId": f"run:{task_id}:{status}",
        },
    })


def _trace(task_id: str, event_id: str, event_type: str, status: str, duration_ms: int | None = None) -> None:
    if not task_id or not event_id:
        return
    _enqueue({
        "_envelope_id": f"trace:{task_id}:{event_type}:{event_id}",
        "kind": "event",
        "sourceId": task_id,
        "input": {
            **_base_input(),
            "eventId": event_id,
            "eventType": event_type,
            "status": status,
            "durationMs": duration_ms,
            "occurredAt": _now(),
        },
    })


def observe_lifecycle(hook_name: str, **kwargs: Any) -> None:
    if not handles_hook(hook_name):
        return
    task_id = str(kwargs.get("task_id") or "")
    if hook_name == "pre_api_request":
        request_id = str(kwargs.get("api_request_id") or "")
        if request_id:
            with _LOCK:
                _MODEL_CALLS[request_id] = (task_id, time.monotonic())
                task = _TASKS.get(task_id)
                if task is not None:
                    if request_id in task["model_calls"]:
                        task["retry_count"] += 1
                    task["model_calls"].add(request_id)
            _trace(task_id, request_id, "model_call_started", "started")
    elif hook_name in {"post_api_request", "api_request_error"}:
        request_id = str(kwargs.get("api_request_id") or "")
        with _LOCK:
            owner, started = _MODEL_CALLS.pop(request_id, (task_id, time.monotonic()))
        status = "completed" if hook_name == "post_api_request" else "failed"
        _trace(owner, request_id, f"model_call_{status}", status, max(0, int((time.monotonic() - started) * 1000)))
    elif hook_name == "pre_tool_call":
        tool_id = str(kwargs.get("tool_call_id") or "")
        if tool_id:
            with _LOCK:
                _TOOL_CALLS[tool_id] = (task_id, time.monotonic())
            _trace(task_id, tool_id, "tool_call_started", "started")
    elif hook_name == "post_tool_call":
        tool_id = str(kwargs.get("tool_call_id") or "")
        with _LOCK:
            owner, started = _TOOL_CALLS.pop(tool_id, (task_id, time.monotonic()))
            task = _TASKS.get(owner)
            failed = str(kwargs.get("status") or "").lower() not in {"ok", "success", "completed"}
            if task is not None:
                task["tool_calls"].add(tool_id or f"anonymous:{len(task['tool_calls'])}")
                task["tool_failures" if failed else "tool_successes"] += 1
        status = "failed" if failed else "completed"
        duration = kwargs.get("duration_ms")
        if not isinstance(duration, int):
            duration = max(0, int((time.monotonic() - started) * 1000))
        _trace(owner, tool_id, f"tool_call_{status}", status, duration)
