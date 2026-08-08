"""Human and automation-friendly CLI for Benaiah Missions."""

from __future__ import annotations

import json
import os
from decimal import Decimal, InvalidOperation
from typing import Any

from hermes_cli import kanban_db as kb
from hermes_cli import missions


def _print(value: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True))
        return
    if isinstance(value, list):
        if not value:
            print("No Missions found.")
            return
        for item in value:
            print(f"{item['id']}  {item['status']:<18} {item['title']}")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, (dict, list)):
                item = json.dumps(item, ensure_ascii=False, sort_keys=True)
            print(f"{key}: {item}")
        return
    print(value)


def _cost_micros(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:
        raise ValueError("max-cost-gbp must be a valid GBP amount") from exc
    if value < 0:
        raise ValueError("max-cost-gbp cannot be negative")
    return int(value * Decimal(1_000_000))


def _mission_view(
    conn, mission: missions.Mission, *, detail: bool = False
) -> dict[str, Any]:
    value = mission.to_dict()
    task = kb.get_task(conn, mission.task_id)
    value["task_status"] = task.status if task else None
    value["workspace"] = task.workspace_path if task else None
    if detail:
        value["attempt_history"] = missions.attempts(conn, mission.id)
        value["events"] = missions.events(conn, mission.id)
    return value


def mission_command(args) -> int:
    command = getattr(args, "mission_command", None)
    if not command:
        print(
            "usage: hermes mission <start|list|show|pause|resume|cancel|approve|receipt|events>"
        )
        return 1
    board = getattr(args, "board", None)
    as_json = bool(getattr(args, "json", False))
    try:
        with kb.connect_closing(board=board) as conn:
            missions.ensure_schema(conn)
            if command in {"start", "create", "run"}:
                workspace = args.workspace or os.getcwd()
                mission = missions.create_mission(
                    conn,
                    objective=args.objective,
                    success_criteria=args.success,
                    title=args.title,
                    worker_runtime=args.worker,
                    verifier_runtime=args.verifier,
                    worker_profile=args.profile,
                    intelligence_tier=args.tier,
                    permission_mode=args.permission,
                    allowed_tools=args.tool,
                    verification_commands=args.check,
                    workspace_kind=args.workspace_kind,
                    workspace_path=workspace
                    if args.workspace_kind != "scratch"
                    else None,
                    max_runtime_seconds=args.max_runtime,
                    max_retries=args.max_retries,
                    max_cost_gbp_micros=_cost_micros(args.max_cost_gbp),
                    created_by="mission-cli",
                    idempotency_key=args.idempotency_key,
                    approve_now=args.approve_now,
                    board=board,
                )
                _print(_mission_view(conn, mission), as_json)
                return 0
            if command == "list":
                values = missions.list_missions(
                    conn,
                    status=args.status,
                    include_terminal=not args.active,
                    limit=args.limit,
                )
                _print([_mission_view(conn, value) for value in values], as_json)
                return 0
            if command in {"show", "status"}:
                _print(
                    _mission_view(
                        conn,
                        missions.get_mission(conn, args.mission_id),
                        detail=command == "show",
                    ),
                    as_json,
                )
                return 0
            if command == "pause":
                value = missions.pause_mission(conn, args.mission_id)
            elif command == "resume":
                value = missions.resume_mission(conn, args.mission_id)
            elif command == "cancel":
                value = missions.cancel_mission(conn, args.mission_id)
            elif command == "approve":
                value = missions.approve_mission(conn, args.mission_id)
            elif command == "receipt":
                receipt = missions.receipt(conn, args.mission_id)
                _print(receipt or {"status": "not_available"}, as_json)
                return 0
            elif command == "events":
                _print(
                    missions.events(conn, args.mission_id, limit=args.limit), as_json
                )
                return 0
            else:
                raise ValueError(f"unknown Mission command: {command}")
            _print(_mission_view(conn, value), as_json)
            return 0
    except (KeyError, ValueError, RuntimeError) as exc:
        if as_json:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        else:
            print(f"Mission error: {exc}")
        return 2
