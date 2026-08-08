"""Process supervisor for one durable Benaiah Mission."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

from hermes_cli import kanban_db as kb
from hermes_cli import missions


_CURRENT_PROCESS: Optional[subprocess.Popen[str]] = None
_STOP = threading.Event()


def _set_state(
    conn,
    mission_id: str,
    status: str,
    phase: str,
    *,
    selected_worker: Optional[str] = None,
    selected_verifier: Optional[str] = None,
    attempt: Optional[int] = None,
    error: Optional[str] = None,
    receipt: Optional[dict[str, Any]] = None,
) -> None:
    now = int(time.time())
    assignments = ["status=?", "current_phase=?", "updated_at=?"]
    values: list[Any] = [status, phase, now]
    if selected_worker is not None:
        assignments.append("selected_worker_runtime=?")
        values.append(selected_worker)
    if selected_verifier is not None:
        assignments.append("selected_verifier_runtime=?")
        values.append(selected_verifier)
    if attempt is not None:
        assignments.append("current_attempt=?")
        values.append(attempt)
    if error is not None:
        assignments.append("last_error=?")
        values.append(error[:1000])
    if status == "running":
        assignments.append("started_at=COALESCE(started_at, ?)")
        values.append(now)
    if status in missions.TERMINAL_STATUSES:
        assignments.append("completed_at=?")
        values.append(now)
    if receipt is not None:
        assignments.append("receipt_json=?")
        values.append(json.dumps(receipt, separators=(",", ":"), sort_keys=True))
    values.append(mission_id)
    with kb.write_txn(conn):
        conn.execute(f"UPDATE missions SET {', '.join(assignments)} WHERE id=?", values)
        missions._event(
            conn,
            mission_id,
            f"state:{status}",
            {
                "phase": phase,
                "attempt": attempt,
                "error": error[:500] if error else None,
            },
        )


def _begin_attempt(conn, mission_id: str, role: str, runtime: str, number: int) -> int:
    with kb.write_txn(conn):
        cursor = conn.execute(
            """
            INSERT INTO mission_attempts
                (mission_id, role, runtime, attempt_number, status, started_at)
            VALUES (?, ?, ?, ?, 'running', ?)
            """,
            (mission_id, role, runtime, number, int(time.time())),
        )
        missions._event(
            conn,
            mission_id,
            f"{role}_started",
            {
                "runtime": runtime,
                "attempt": number,
            },
        )
        return int(cursor.lastrowid)


def _finish_attempt(
    conn,
    attempt_id: int,
    *,
    status: str,
    exit_code: int,
    summary: str = "",
    evidence: Optional[dict[str, Any]] = None,
    pid: Optional[int] = None,
) -> None:
    with kb.write_txn(conn):
        row = conn.execute(
            "SELECT mission_id, role, runtime, attempt_number FROM mission_attempts WHERE id=?",
            (attempt_id,),
        ).fetchone()
        conn.execute(
            """
            UPDATE mission_attempts
               SET status=?, ended_at=?, pid=?, exit_code=?, summary=?, evidence_json=?
             WHERE id=?
            """,
            (
                status,
                int(time.time()),
                pid,
                int(exit_code),
                summary[-4000:] or None,
                json.dumps(evidence, separators=(",", ":"), sort_keys=True)
                if evidence
                else None,
                attempt_id,
            ),
        )
        if row:
            missions._event(
                conn,
                row["mission_id"],
                f"{row['role']}_{status}",
                {
                    "runtime": row["runtime"],
                    "attempt": int(row["attempt_number"]),
                    "exit_code": int(exit_code),
                },
            )


def _runtime_binary(runtime: str) -> Optional[str]:
    override = os.environ.get(f"BENAIAH_MISSION_{runtime.upper()}_BIN", "").strip()
    if override:
        return override
    preferred = "codex-benaiah" if runtime == "codex" else "hermes-benaiah"
    fallback = "codex" if runtime == "codex" else "hermes"
    return shutil.which(preferred) or shutil.which(fallback)


def effective_managed_cli_tier(mission: missions.Mission) -> str:
    """Return the tier the managed CLI gateway will actually execute."""
    return "pro" if mission.intelligence_tier == "pro" else "high"


def select_worker(mission: missions.Mission, workspace: Path) -> str:
    if mission.worker_runtime != "auto":
        if not _runtime_binary(mission.worker_runtime):
            raise RuntimeError(f"{mission.worker_runtime} CLI is not installed")
        if (
            mission.worker_runtime == "hermes"
            and mission.permission_mode == "workspace_write"
        ):
            raise RuntimeError(
                "Hermes cannot yet enforce a workspace-only write boundary; "
                "choose Codex, read-only, or explicitly approved full access"
            )
        return mission.worker_runtime
    is_git = (workspace / ".git").exists()
    if not is_git:
        probe = (
            subprocess.run(
                ["git", "-C", str(workspace), "rev-parse", "--is-inside-work-tree"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if shutil.which("git") and workspace.is_dir()
            else None
        )
        is_git = bool(probe and probe.returncode == 0)
    # Codex exposes a native workspace-write sandbox. Hermes currently exposes
    # safe read-only and explicitly approved unrestricted modes, but no honest
    # workspace-only boundary. Never silently widen the operator's authority.
    if mission.permission_mode == "workspace_write":
        order = ("codex",)
    else:
        order = ("codex", "hermes") if is_git else ("hermes", "codex")
    for runtime in order:
        if _runtime_binary(runtime):
            return runtime
    if mission.permission_mode == "workspace_write":
        raise RuntimeError(
            "Codex is required to enforce this Mission's workspace-only authority"
        )
    raise RuntimeError("no supported Mission worker is installed")


def select_verifier(mission: missions.Mission, worker: str) -> Optional[str]:
    if mission.verifier_runtime == "none":
        return None
    if mission.verifier_runtime != "auto":
        if mission.verifier_runtime == worker:
            raise RuntimeError("the primary worker cannot independently verify itself")
        if not _runtime_binary(mission.verifier_runtime):
            raise RuntimeError(f"{mission.verifier_runtime} verifier is not installed")
        return mission.verifier_runtime
    other = "hermes" if worker == "codex" else "codex"
    if _runtime_binary(other):
        return other
    raise RuntimeError(f"independent {other} verifier is not installed")


def _mission_prompt(mission: missions.Mission, feedback: str = "") -> str:
    tools = (
        ", ".join(mission.allowed_tools)
        if mission.allowed_tools
        else "the runtime's approved defaults"
    )
    prompt = f"""You are the primary worker for a Benaiah Mission.

Objective:
{mission.objective}

Success criteria:
{mission.success_criteria}

Authority: {mission.permission_mode}
Allowed toolsets: {tools}

Complete the objective inside the supplied workspace. Respect the authority boundary. Do not deploy,
send external messages, spend money, delete material data, or escape the workspace unless that action
is explicitly contained in both the objective and the approved authority. Finish with a concise account
of what changed and what evidence supports completion.
"""
    if feedback:
        prompt += f"\nIndependent verification feedback from the prior attempt:\n{feedback[-3000:]}\n"
    return prompt


def _verifier_prompt(mission: missions.Mission, worker_summary: str) -> str:
    return f"""You are the independent verifier for a Benaiah Mission. Inspect the workspace read-only.
Do not alter files, run destructive commands, send messages, deploy, or spend money.

Objective:
{mission.objective}

Success criteria:
{mission.success_criteria}

Primary worker summary:
{worker_summary[-3000:]}

Return JSON only with exactly these fields:
{{"passed": true or false, "summary": "brief evidence-based verdict", "evidence": ["brief item"]}}
Only pass when the workspace evidence meets every success criterion.
"""


def _terminate_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            process.terminate()
        else:
            os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except Exception:
        try:
            if sys.platform == "win32":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except Exception:
            pass


def _run_process(
    command: list[str], workspace: Path, timeout: float
) -> tuple[int, str, int]:
    global _CURRENT_PROCESS
    process = subprocess.Popen(
        command,
        cwd=str(workspace),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env={
            key: value
            for key, value in os.environ.items()
            if key
            not in {
                "HERMES_KANBAN_TASK",
                "HERMES_KANBAN_RUN_ID",
                "HERMES_KANBAN_CLAIM_LOCK",
            }
        },
        start_new_session=True,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    _CURRENT_PROCESS = process
    try:
        output, _ = process.communicate(timeout=max(1.0, timeout))
        return int(process.returncode or 0), output or "", process.pid
    except subprocess.TimeoutExpired:
        _terminate_process(process)
        output = process.stdout.read() if process.stdout else ""
        return 124, output or "", process.pid
    finally:
        _CURRENT_PROCESS = None


def _worker_command(
    runtime: str,
    mission: missions.Mission,
    workspace: Path,
    prompt: str,
    output_path: Path,
) -> list[str]:
    binary = _runtime_binary(runtime)
    if not binary:
        raise RuntimeError(f"{runtime} CLI is not installed")
    if runtime == "codex":
        command = [
            binary,
            "exec",
            "--json",
            "-C",
            str(workspace),
            "-o",
            str(output_path),
            "--ephemeral",
        ]
        if effective_managed_cli_tier(mission) == "pro":
            command.extend(["-m", "benaiah-capability"])
        if mission.permission_mode == "full_access":
            if mission.approved_at is None:
                raise PermissionError("full_access Mission has not been approved")
            command.append("--dangerously-bypass-approvals-and-sandbox")
        else:
            sandbox = (
                "read-only"
                if mission.permission_mode == "read_only"
                else "workspace-write"
            )
            command.extend(["-s", sandbox])
        command.append(prompt)
        return command
    command = [binary, "--cli", "--accept-hooks"]
    if effective_managed_cli_tier(mission) == "pro":
        command.extend(["-m", "benaiah-capability"])
    if mission.allowed_tools:
        command.extend(["--toolsets", ",".join(mission.allowed_tools)])
    if mission.permission_mode == "read_only":
        command.append("--safe-mode")
    elif mission.permission_mode == "full_access":
        if mission.approved_at is None:
            raise PermissionError("full_access Mission has not been approved")
        command.append("--yolo")
    command.extend(["chat", "-q", prompt, "-Q"])
    return command


def _run_worker(
    runtime: str,
    mission: missions.Mission,
    workspace: Path,
    timeout: float,
    feedback: str,
) -> tuple[int, str, int]:
    with tempfile.NamedTemporaryFile(
        prefix="benaiah-mission-", suffix=".txt", delete=False
    ) as handle:
        output_path = Path(handle.name)
    try:
        code, stdout, pid = _run_process(
            _worker_command(
                runtime,
                mission,
                workspace,
                _mission_prompt(mission, feedback),
                output_path,
            ),
            workspace,
            timeout,
        )
        if runtime == "codex" and output_path.exists():
            final = output_path.read_text(encoding="utf-8", errors="replace").strip()
            if final:
                stdout = final
        return code, stdout[-12000:], pid
    finally:
        output_path.unlink(missing_ok=True)


def _extract_json(text: str) -> Optional[dict[str, Any]]:
    stripped = text.strip()
    candidates = [stripped]
    candidates.extend(
        line.strip()
        for line in reversed(stripped.splitlines())
        if line.strip().startswith("{")
    )
    start, end = stripped.find("{"), stripped.rfind("}")
    if start >= 0 and end > start:
        candidates.append(stripped[start : end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except (TypeError, ValueError):
            continue
        if isinstance(value, dict) and isinstance(value.get("passed"), bool):
            return value
    return None


def _run_verifier(
    runtime: str,
    mission: missions.Mission,
    workspace: Path,
    timeout: float,
    summary: str,
) -> tuple[int, dict[str, Any], int]:
    verifier_mission = mission
    with tempfile.NamedTemporaryFile(
        prefix="benaiah-verify-", suffix=".txt", delete=False
    ) as handle:
        output_path = Path(handle.name)
    try:
        if runtime == "codex":
            binary = _runtime_binary("codex")
            if binary is None:
                raise RuntimeError("codex verifier is not installed")
            command = [
                binary,
                "exec",
                "--json",
                "-C",
                str(workspace),
                "-s",
                "read-only",
                "-o",
                str(output_path),
                "--ephemeral",
                _verifier_prompt(verifier_mission, summary),
            ]
        else:
            binary = _runtime_binary("hermes")
            if binary is None:
                raise RuntimeError("hermes verifier is not installed")
            command = [
                binary,
                "--cli",
                "--accept-hooks",
                "--safe-mode",
                "chat",
                "-q",
                _verifier_prompt(verifier_mission, summary),
                "-Q",
            ]
        code, stdout, pid = _run_process(command, workspace, timeout)
        if runtime == "codex" and output_path.exists():
            content = output_path.read_text(encoding="utf-8", errors="replace").strip()
            if content:
                stdout = content
        verdict = _extract_json(stdout) or {
            "passed": False,
            "summary": "Verifier did not return a valid structured verdict.",
            "evidence": [],
        }
        return code, verdict, pid
    finally:
        output_path.unlink(missing_ok=True)


def _run_checks(
    commands: list[str], workspace: Path, deadline: float
) -> tuple[bool, list[dict[str, Any]]]:
    results: list[dict[str, Any]] = []
    for command in commands:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            results.append({"command": command, "passed": False, "exit_code": 124})
            return False, results
        argv = (
            ["powershell", "-NoProfile", "-Command", command]
            if sys.platform == "win32"
            else ["/bin/sh", "-lc", command]
        )
        code, output, _ = _run_process(argv, workspace, min(remaining, 300))
        results.append({
            "command": command,
            "passed": code == 0,
            "exit_code": code,
            "summary": output[-1000:],
        })
        if code != 0:
            return False, results
    return True, results


def _git_status(workspace: Path) -> Optional[set[str]]:
    if not shutil.which("git"):
        return None
    result = subprocess.run(
        ["git", "-C", str(workspace), "status", "--porcelain=v1", "-z"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return {item for item in result.stdout.split("\0") if item}


def _heartbeat(task_id: str, claim_lock: str, board: str) -> None:
    while not _STOP.wait(30):
        try:
            with kb.connect_closing(board=board) as connection:
                if not kb.heartbeat_claim(connection, task_id, claimer=claim_lock):
                    _STOP.set()
                    if _CURRENT_PROCESS is not None:
                        _terminate_process(_CURRENT_PROCESS)
                    return
        except Exception:
            continue


def _receipt(
    mission: missions.Mission,
    *,
    status: str,
    worker: str,
    verifier: Optional[str],
    started_at: int,
    attempts_count: int,
    checks: list[dict[str, Any]],
    verdict: Optional[dict[str, Any]],
    changed_file_count: Optional[int],
    workspace: Path,
) -> dict[str, Any]:
    completed_at = int(time.time())
    return {
        "mission_id": mission.id,
        "task_id": mission.task_id,
        "status": status,
        "worker": worker,
        "verifier": verifier,
        "started_at": started_at,
        "completed_at": completed_at,
        "duration_seconds": max(0, completed_at - started_at),
        "attempts": attempts_count,
        "retries": max(0, attempts_count - 1),
        "checks": checks,
        "verifier_verdict": verdict,
        "changed_file_count": changed_file_count,
        "observed_cost_gbp": None,
        "requested_intelligence_tier": mission.intelligence_tier,
        "effective_managed_cli_tier": effective_managed_cli_tier(mission),
        "worktree_available": workspace.exists(),
    }


def run_mission(mission_id: str, workspace: Path, board: str) -> int:
    from hermes_cli.observability.benaiah_outcome_relay import (
        finish_task_run,
        start_task_run,
    )

    _STOP.clear()
    with kb.connect_closing(board=board) as conn:
        missions.ensure_schema(conn)
        mission = missions.get_mission(conn, mission_id)
        task = kb.get_task(conn, mission.task_id)
        if task is None or task.status != "running" or not task.claim_lock:
            raise RuntimeError("Mission task does not hold an active execution lease")
        if mission.permission_mode == "full_access" and mission.approved_at is None:
            kb.block_task(
                conn,
                mission.task_id,
                reason="full_access Mission needs approval",
                kind="needs_input",
                expected_run_id=task.current_run_id,
            )
            missions._mark_blocked(
                conn, mission.id, "full_access Mission needs approval"
            )
            return 2
        try:
            worker = select_worker(mission, workspace)
            verifier = select_verifier(mission, worker)
        except Exception as exc:
            kb.block_task(
                conn,
                mission.task_id,
                reason=str(exc)[:1000],
                kind="capability",
                expected_run_id=task.current_run_id,
            )
            failure_receipt = missions._control_receipt(
                mission, "blocked", int(time.time())
            )
            failure_receipt["error_category"] = "capability"
            _set_state(
                conn,
                mission.id,
                "blocked",
                "blocked",
                error=str(exc),
                receipt=failure_receipt,
            )
            return 2
        started_at = int(time.time())
        _set_state(
            conn,
            mission.id,
            "running",
            "primary",
            selected_worker=worker,
            selected_verifier=verifier,
        )
        mission = missions.get_mission(conn, mission.id)
        task_id, claim_lock, expected_run_id = (
            task.id,
            task.claim_lock,
            task.current_run_id,
        )

    start_task_run(
        session_id="",
        task_id=mission.id,
        platform="mission-control",
        feature="missions",
        task_class="mission",
        auto_tier=effective_managed_cli_tier(mission),
    )
    heartbeat = threading.Thread(
        target=_heartbeat, args=(task_id, claim_lock, board), daemon=True
    )
    heartbeat.start()
    deadline = time.monotonic() + mission.max_runtime_seconds
    before = _git_status(workspace)
    feedback = ""
    final_summary = ""
    checks: list[dict[str, Any]] = []
    verdict: Optional[dict[str, Any]] = None
    terminal_error: Optional[BaseException] = None
    attempt_number = 0
    try:
        for attempt_number in range(1, mission.max_retries + 2):
            if _STOP.is_set():
                raise InterruptedError("Mission lease was revoked")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                feedback = "Mission runtime budget exhausted."
                break
            with kb.connect_closing(board=board) as conn:
                _set_state(
                    conn, mission.id, "running", "primary", attempt=attempt_number
                )
                attempt_id = _begin_attempt(
                    conn, mission.id, "primary", worker, attempt_number
                )
            code, summary, pid = _run_worker(
                worker, mission, workspace, remaining, feedback
            )
            final_summary = summary
            with kb.connect_closing(board=board) as conn:
                _finish_attempt(
                    conn,
                    attempt_id,
                    status="completed" if code == 0 else "failed",
                    exit_code=code,
                    summary=summary,
                    pid=pid,
                )
            if code != 0:
                feedback = f"Primary worker exited with code {code}. {summary[-1500:]}"
                continue

            with kb.connect_closing(board=board) as conn:
                _set_state(
                    conn,
                    mission.id,
                    "verifying",
                    "deterministic_checks",
                    attempt=attempt_number,
                )
            checks_passed, checks = _run_checks(
                mission.verification_commands, workspace, deadline
            )
            if not checks_passed:
                feedback = "A deterministic verification command failed: " + (
                    checks[-1].get("summary") or ""
                )
                continue

            if verifier is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    feedback = "Mission runtime budget exhausted before independent verification."
                    break
                with kb.connect_closing(board=board) as conn:
                    _set_state(
                        conn,
                        mission.id,
                        "verifying",
                        "independent_verifier",
                        attempt=attempt_number,
                    )
                    verifier_id = _begin_attempt(
                        conn, mission.id, "verifier", verifier, attempt_number
                    )
                verify_code, verdict, verifier_pid = _run_verifier(
                    verifier, mission, workspace, remaining, summary
                )
                passed = verify_code == 0 and verdict.get("passed") is True
                with kb.connect_closing(board=board) as conn:
                    _finish_attempt(
                        conn,
                        verifier_id,
                        status="passed" if passed else "failed",
                        exit_code=verify_code,
                        summary=str(verdict.get("summary") or ""),
                        evidence=verdict,
                        pid=verifier_pid,
                    )
                if not passed:
                    feedback = str(
                        verdict.get("summary") or "Independent verification failed."
                    )
                    continue

            after = _git_status(workspace)
            changed_count = (
                len(after) if before == set() and after is not None else None
            )
            action_receipt = _receipt(
                mission,
                status="succeeded",
                worker=worker,
                verifier=verifier,
                started_at=started_at,
                attempts_count=attempt_number,
                checks=checks,
                verdict=verdict,
                changed_file_count=changed_count,
                workspace=workspace,
            )
            with kb.connect_closing(board=board) as conn:
                if not kb.complete_task(
                    conn,
                    mission.task_id,
                    result="Mission completed and independently verified.",
                    summary=(verdict or {}).get("summary") or final_summary[-1000:],
                    metadata={
                        "mission_id": mission.id,
                        "worker": worker,
                        "verifier": verifier,
                        "attempts": attempt_number,
                        "verified": True,
                    },
                    expected_run_id=expected_run_id,
                ):
                    raise RuntimeError(
                        "Mission lost its execution lease before completion"
                    )
                _set_state(
                    conn,
                    mission.id,
                    "succeeded",
                    "terminal",
                    attempt=attempt_number,
                    receipt=action_receipt,
                )
            finish_task_run(
                session_id="",
                task_id=mission.id,
                platform="mission-control",
                result={"failed": False},
                feature="missions",
                task_class="mission",
                auto_tier=effective_managed_cli_tier(mission),
            )
            return 0

        reason = (
            feedback
            or "Mission exhausted its bounded attempts without verified completion."
        )
        action_receipt = _receipt(
            mission,
            status="blocked",
            worker=worker,
            verifier=verifier,
            started_at=started_at,
            attempts_count=attempt_number,
            checks=checks,
            verdict=verdict,
            changed_file_count=None,
            workspace=workspace,
        )
        with kb.connect_closing(board=board) as conn:
            kb.block_task(
                conn,
                mission.task_id,
                reason=reason[:1000],
                kind="needs_input",
                expected_run_id=expected_run_id,
            )
            _set_state(
                conn,
                mission.id,
                "blocked",
                "blocked",
                attempt=attempt_number,
                error=reason,
                receipt=action_receipt,
            )
        terminal_error = RuntimeError(reason)
        finish_task_run(
            session_id="",
            task_id=mission.id,
            platform="mission-control",
            result={"failed": True},
            error=terminal_error,
            feature="missions",
            task_class="mission",
            auto_tier=effective_managed_cli_tier(mission),
        )
        return 2
    except BaseException as exc:
        terminal_error = exc
        with kb.connect_closing(board=board) as conn:
            current = kb.get_task(conn, mission.task_id)
            if current and current.status == "running":
                kb.block_task(
                    conn,
                    mission.task_id,
                    reason=str(exc)[:1000],
                    kind="capability",
                    expected_run_id=current.current_run_id,
                )
            current_mission = missions.get_mission(conn, mission.id)
            if (
                current_mission.status not in missions.TERMINAL_STATUSES
                and current_mission.status != "paused"
            ):
                action_receipt = _receipt(
                    mission,
                    status="blocked",
                    worker=worker,
                    verifier=verifier,
                    started_at=started_at,
                    attempts_count=attempt_number,
                    checks=checks,
                    verdict=verdict,
                    changed_file_count=None,
                    workspace=workspace,
                )
                _set_state(
                    conn,
                    mission.id,
                    "blocked",
                    "blocked",
                    attempt=attempt_number,
                    error=str(exc),
                    receipt=action_receipt,
                )
        finish_task_run(
            session_id="",
            task_id=mission.id,
            platform="mission-control",
            result={"failed": True},
            error=exc,
            feature="missions",
            task_class="mission",
            auto_tier=effective_managed_cli_tier(mission),
        )
        return 130 if isinstance(exc, (KeyboardInterrupt, InterruptedError)) else 2
    finally:
        _STOP.set()


def _handle_signal(_signum, _frame) -> None:
    _STOP.set()
    if _CURRENT_PROCESS is not None:
        _terminate_process(_CURRENT_PROCESS)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run one claimed Benaiah Mission")
    parser.add_argument("--mission", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--board", default="default")
    args = parser.parse_args(argv)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _handle_signal)
    return run_mission(args.mission, Path(args.workspace).resolve(), args.board)


if __name__ == "__main__":
    raise SystemExit(main())
