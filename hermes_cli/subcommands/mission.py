"""Argument parser for ``hermes mission``."""

from __future__ import annotations

from typing import Callable


def build_mission_parser(subparsers, *, cmd_mission: Callable) -> None:
    parser = subparsers.add_parser(
        "mission",
        help="Create and supervise persistent outcome-driven work",
        description="Benaiah Missions supervise Codex and Hermes against an explicit outcome contract.",
    )
    parser.set_defaults(func=cmd_mission)
    parser.add_argument(
        "--board", default=None, help="Kanban board (default: active board)"
    )
    commands = parser.add_subparsers(dest="mission_command")

    start = commands.add_parser(
        "start", aliases=["create", "run"], help="Create a Mission"
    )
    start.add_argument("objective", help="The outcome Benaiah should deliver")
    start.add_argument(
        "--success", required=True, help="Evidence that proves completion"
    )
    start.add_argument("--title")
    start.add_argument("--worker", choices=["auto", "codex", "hermes"], default="auto")
    start.add_argument(
        "--verifier", choices=["auto", "none", "codex", "hermes"], default="auto"
    )
    start.add_argument("--profile")
    start.add_argument(
        "--tier",
        choices=["instant", "medium", "high", "extra-high", "pro"],
        default="high",
    )
    start.add_argument(
        "--permission",
        choices=["read-only", "workspace-write", "full-access"],
        default="workspace-write",
    )
    start.add_argument(
        "--workspace",
        default=None,
        help="Workspace directory (default: current directory)",
    )
    start.add_argument(
        "--workspace-kind", choices=["dir", "worktree", "scratch"], default="dir"
    )
    start.add_argument(
        "--tool", action="append", default=[], help="Fixed Hermes toolset; repeatable"
    )
    start.add_argument(
        "--check",
        action="append",
        default=[],
        help="Deterministic verification command; repeatable",
    )
    start.add_argument("--max-runtime", type=int, default=1800, metavar="SECONDS")
    start.add_argument("--max-retries", type=int, default=1)
    start.add_argument("--max-cost-gbp", type=str, default=None)
    start.add_argument("--idempotency-key")
    start.add_argument(
        "--approve-now",
        action="store_true",
        help="Explicitly approve a full-access Mission now",
    )
    start.add_argument("--json", action="store_true")

    listing = commands.add_parser("list", help="List Missions")
    listing.add_argument("--status")
    listing.add_argument("--active", action="store_true", help="Hide terminal Missions")
    listing.add_argument("--limit", type=int, default=100)
    listing.add_argument("--json", action="store_true")

    for name in (
        "show",
        "status",
        "pause",
        "resume",
        "cancel",
        "approve",
        "receipt",
        "events",
    ):
        sub = commands.add_parser(name)
        sub.add_argument("mission_id")
        if name == "events":
            sub.add_argument("--limit", type=int, default=200)
        sub.add_argument("--json", action="store_true")
