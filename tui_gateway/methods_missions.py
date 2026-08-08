"""JSON-RPC controls for the local Benaiah Mission Control Plane."""

from typing import TYPE_CHECKING, Any

from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()
method = _registry.method

if TYPE_CHECKING:
    # HandlerRegistry installs these functions into server.py's globals.  The
    # declarations describe that deliberate runtime binding to static tools.
    def _ok(rid: Any, result: Any) -> dict: ...
    def _err(rid: Any, code: int, message: str) -> dict: ...
    def _mission_rpc_view(conn: Any, mission: Any, *, detail: bool = False) -> dict: ...
    def _mission_rpc_control(rid: Any, params: dict, action: str) -> dict: ...


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
            return _ok(
                rid, {"missions": [_mission_rpc_view(conn, value) for value in values]}
            )
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
            return _ok(rid, {"mission": _mission_rpc_view(conn, mission)})
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
            return _ok(
                rid, {"mission": _mission_rpc_view(conn, function(conn, mission_id))}
            )
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
    server._mission_rpc_control = types.FunctionType(
        _control.__code__,
        vars(server),
        _control.__name__,
        _control.__defaults__,
        _control.__closure__,
    )
    _registry.install(server)
