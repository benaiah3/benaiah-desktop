"""JSON-RPC controls for the local Benaiah Mission Control Plane."""

import logging
import threading
from typing import TYPE_CHECKING, Any

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method

logger = logging.getLogger(__name__)
_dispatch_lock = threading.Lock()
_dispatch_pending: dict[str, set[str]] = {}
_dispatch_threads: dict[str, threading.Thread] = {}

if TYPE_CHECKING:
    # HandlerRegistry installs these functions into server.py's globals.  The
    # declarations describe that deliberate runtime binding to static tools.
    def _ok(rid: Any, result: Any) -> dict: ...
    def _err(rid: Any, code: int, message: str) -> dict: ...
    def _mission_rpc_view(conn: Any, mission: Any, *, detail: bool = False) -> dict: ...
    def _mission_rpc_control(rid: Any, params: dict, action: str) -> dict: ...
    def _mission_dispatch_kick(board: Any, task_ids: Any) -> None: ...


def _dispatch_board(key: str, board: str | None) -> None:
    """Drain Mission-specific dispatch requests for one board."""
    from hermes_cli import kanban_db as kb

    while True:
        with _dispatch_lock:
            task_ids = tuple(_dispatch_pending.get(key, ()))
            if not task_ids:
                _dispatch_pending.pop(key, None)
                _dispatch_threads.pop(key, None)
                return
            _dispatch_pending[key].clear()
        try:
            with kb.connect_closing(board=board) as conn:
                kb.dispatch_once(conn, board=board, task_ids=task_ids)
        except Exception:
            # Dispatch is durable: the task remains queued and the next
            # Missions refresh will wake it again. Keep the RPC responsive and
            # leave a diagnostic instead of killing this coordinator thread.
            logger.exception("Mission dispatcher wake-up failed for board %r", board)


def _kick_dispatch(board: Any, task_ids: Any) -> None:
    """Wake the existing dispatcher for only the supplied Mission tasks."""
    normalized_board = str(board or "").strip() or None
    normalized_ids = {str(task_id) for task_id in task_ids if task_id}
    if not normalized_ids:
        return
    key = normalized_board or "default"
    with _dispatch_lock:
        _dispatch_pending.setdefault(key, set()).update(normalized_ids)
        current = _dispatch_threads.get(key)
        if current is not None and current.is_alive():
            return
        worker = threading.Thread(
            target=_dispatch_board,
            args=(key, normalized_board),
            name=f"benaiah-missions-{key}",
            daemon=True,
        )
        _dispatch_threads[key] = worker
        try:
            worker.start()
        except RuntimeError:
            _dispatch_threads.pop(key, None)
            logger.exception("Mission dispatcher coordinator could not start")


def _view(conn, mission, *, detail=False):
    from hermes_cli import kanban_db as kb
    from hermes_cli import missions

    value = mission.to_dict()
    task = kb.get_task(conn, mission.task_id)
    value["task_status"] = task.status if task else None
    value["workspace"] = task.workspace_path if task else None
    if detail:
        value["attempt_history"] = missions.attempts(conn, mission.id)
        value["events"] = missions.events(conn, mission.id)
    return value


@method("missions.list")
def _(rid, params: dict) -> dict:
    try:
        from hermes_cli import kanban_db as kb
        from hermes_cli import missions

        with kb.connect_closing(board=params.get("board")) as conn:
            values = missions.list_missions(
                conn,
                status=params.get("status") or None,
                include_terminal=bool(params.get("include_terminal", True)),
                limit=int(params.get("limit") or 100),
            )
            response = _ok(
                rid, {"missions": [_mission_rpc_view(conn, value) for value in values]}
            )
            active_task_ids = [
                value.task_id
                for value in values
                if value.status in {"queued", "running", "verifying"}
            ]
        _mission_dispatch_kick(params.get("board"), active_task_ids)
        return response
    except Exception as exc:
        return _err(rid, 5080, str(exc))


@method("missions.get")
def _(rid, params: dict) -> dict:
    mission_id = str(params.get("mission_id") or "")
    if not mission_id:
        return _err(rid, 4080, "mission_id required")
    try:
        from hermes_cli import kanban_db as kb
        from hermes_cli import missions

        with kb.connect_closing(board=params.get("board")) as conn:
            return _ok(
                rid,
                {
                    "mission": _mission_rpc_view(
                        conn, missions.get_mission(conn, mission_id), detail=True
                    )
                },
            )
    except KeyError as exc:
        return _err(rid, 4081, str(exc))
    except Exception as exc:
        return _err(rid, 5080, str(exc))


@method("missions.create")
def _(rid, params: dict) -> dict:
    try:
        from decimal import Decimal
        from hermes_cli import kanban_db as kb
        from hermes_cli import missions

        raw_cost = params.get("max_cost_gbp")
        max_cost = (
            int(Decimal(str(raw_cost)) * Decimal(1_000_000))
            if raw_cost is not None
            else None
        )
        raw_retries = params.get("max_retries")
        max_retries = 1 if raw_retries is None else int(raw_retries)
        with kb.connect_closing(board=params.get("board")) as conn:
            mission = missions.create_mission(
                conn,
                objective=str(params.get("objective") or ""),
                success_criteria=str(params.get("success_criteria") or ""),
                title=params.get("title") or None,
                worker_runtime=str(params.get("worker_runtime") or "auto"),
                verifier_runtime=str(params.get("verifier_runtime") or "auto"),
                worker_profile=params.get("worker_profile") or None,
                intelligence_tier=str(params.get("intelligence_tier") or "high"),
                permission_mode=str(params.get("permission_mode") or "workspace_write"),
                allowed_tools=params.get("allowed_tools") or [],
                verification_commands=params.get("verification_commands") or [],
                workspace_kind=str(params.get("workspace_kind") or "dir"),
                workspace_path=params.get("workspace_path") or None,
                max_runtime_seconds=int(params.get("max_runtime_seconds") or 1800),
                max_retries=max_retries,
                max_cost_gbp_micros=max_cost,
                created_by="desktop",
                idempotency_key=params.get("idempotency_key") or None,
                approve_now=bool(params.get("approve_now", False)),
                board=params.get("board"),
            )
            response = _ok(rid, {"mission": _mission_rpc_view(conn, mission)})
        if mission.status == "queued":
            _mission_dispatch_kick(params.get("board"), [mission.task_id])
        return response
    except (ValueError, KeyError) as exc:
        return _err(rid, 4082, str(exc))
    except Exception as exc:
        return _err(rid, 5080, str(exc))


def _control(rid, params: dict, action: str) -> dict:
    mission_id = str(params.get("mission_id") or "")
    if not mission_id:
        return _err(rid, 4080, "mission_id required")
    try:
        from hermes_cli import kanban_db as kb
        from hermes_cli import missions

        function = {
            "pause": missions.pause_mission,
            "resume": missions.resume_mission,
            "cancel": missions.cancel_mission,
            "approve": missions.approve_mission,
        }[action]
        with kb.connect_closing(board=params.get("board")) as conn:
            mission = function(conn, mission_id)
            response = _ok(rid, {"mission": _mission_rpc_view(conn, mission)})
        if action in {"resume", "approve"} and mission.status == "queued":
            _mission_dispatch_kick(params.get("board"), [mission.task_id])
        return response
    except (ValueError, KeyError, RuntimeError) as exc:
        return _err(rid, 4083, str(exc))
    except Exception as exc:
        return _err(rid, 5080, str(exc))


@method("missions.pause")
def _(rid, params: dict) -> dict:
    return _mission_rpc_control(rid, params, "pause")


@method("missions.resume")
def _(rid, params: dict) -> dict:
    return _mission_rpc_control(rid, params, "resume")


@method("missions.cancel")
def _(rid, params: dict) -> dict:
    return _mission_rpc_control(rid, params, "cancel")


@method("missions.approve")
def _(rid, params: dict) -> dict:
    return _mission_rpc_control(rid, params, "approve")


@method("missions.receipt")
def _(rid, params: dict) -> dict:
    mission_id = str(params.get("mission_id") or "")
    if not mission_id:
        return _err(rid, 4080, "mission_id required")
    try:
        from hermes_cli import kanban_db as kb
        from hermes_cli import missions

        with kb.connect_closing(board=params.get("board")) as conn:
            return _ok(rid, {"receipt": missions.receipt(conn, mission_id)})
    except (KeyError, ValueError) as exc:
        return _err(rid, 4081, str(exc))
    except Exception as exc:
        return _err(rid, 5080, str(exc))


def register(server) -> None:
    import types

    server._mission_rpc_view = _view
    server._mission_dispatch_kick = _kick_dispatch
    server._mission_rpc_control = types.FunctionType(
        _control.__code__,
        vars(server),
        _control.__name__,
        _control.__defaults__,
        _control.__closure__,
    )
    _registry.install(server)
