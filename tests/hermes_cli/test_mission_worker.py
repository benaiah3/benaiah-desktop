from __future__ import annotations

import stat
from pathlib import Path

from hermes_cli import kanban_db as kb
from hermes_cli import mission_worker
from hermes_cli import missions


def _executable(path: Path, source: str) -> str:
    path.write_text(source, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


def test_worker_and_independent_verifier_complete_a_real_mission(tmp_path, monkeypatch):
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))

    codex = _executable(
        tmp_path / "fake-codex",
        """#!/usr/bin/env python3
import pathlib, sys
args = sys.argv[1:]
out = pathlib.Path(args[args.index('-o') + 1])
pathlib.Path('proof.txt').write_text('ok\\n', encoding='utf-8')
out.write_text('Created proof.txt and verified its contents.', encoding='utf-8')
""",
    )
    hermes = _executable(
        tmp_path / "fake-hermes",
        """#!/usr/bin/env python3
print('{"passed": true, "summary": "proof.txt contains ok", "evidence": ["proof.txt"]}')
""",
    )
    monkeypatch.setenv("BENAIAH_MISSION_CODEX_BIN", codex)
    monkeypatch.setenv("BENAIAH_MISSION_HERMES_BIN", hermes)
    mission_worker._STOP.clear()

    with kb.connect_closing() as conn:
        mission = missions.create_mission(
            conn,
            objective="Create proof.txt containing ok",
            success_criteria="proof.txt exists and contains exactly ok",
            worker_runtime="codex",
            verifier_runtime="hermes",
            verification_commands=['test "$(cat proof.txt)" = ok'],
            workspace_path=str(workspace),
            max_runtime_seconds=30,
        )
        claimed = kb.claim_task(conn, mission.task_id, claimer="test-host:123")
        assert claimed is not None

    assert mission_worker.run_mission(mission.id, workspace, "default") == 0

    with kb.connect_closing() as conn:
        finished = missions.get_mission(conn, mission.id)
        task = kb.get_task(conn, mission.task_id)
        assert finished.status == "succeeded"
        assert finished.selected_worker_runtime == "codex"
        assert finished.selected_verifier_runtime == "hermes"
        assert finished.receipt["verifier_verdict"]["passed"] is True
        assert finished.receipt["observed_cost_gbp"] is None
        assert task is not None and task.status == "done"
        history = missions.attempts(conn, mission.id)
        assert [entry["role"] for entry in history] == ["primary", "verifier"]


def test_codex_full_access_flag_requires_recorded_approval(tmp_path, monkeypatch):
    monkeypatch.setenv("BENAIAH_MISSION_CODEX_BIN", "/bin/true")
    mission = missions.Mission(
        id="m_test",
        task_id="t_test",
        title="test",
        objective="test",
        success_criteria="done",
        status="running",
        worker_runtime="codex",
        selected_worker_runtime=None,
        worker_profile="default",
        verifier_runtime="none",
        selected_verifier_runtime=None,
        intelligence_tier="high",
        permission_mode="full_access",
        allowed_tools=[],
        verification_commands=[],
        max_runtime_seconds=30,
        max_retries=0,
        max_cost_gbp_micros=None,
        created_by=None,
        created_at=1,
        updated_at=1,
        started_at=None,
        completed_at=None,
        approved_at=None,
        current_phase=None,
        current_attempt=0,
        last_error=None,
        receipt=None,
    )
    try:
        mission_worker._worker_command(
            "codex", mission, tmp_path, "prompt", tmp_path / "out"
        )
    except PermissionError:
        pass
    else:
        raise AssertionError("unapproved full-access Mission built a runnable command")


def test_kanban_default_spawn_routes_mission_to_supervisor(tmp_path, monkeypatch):
    task = kb.Task(
        id="t_mission",
        title="Mission",
        body=None,
        assignee="default",
        status="running",
        priority=0,
        created_by="test",
        created_at=1,
        started_at=1,
        completed_at=None,
        workspace_kind="dir",
        workspace_path=str(tmp_path),
        claim_lock="test:1",
        claim_expires=999,
        tenant=None,
    )
    monkeypatch.setattr(missions, "maybe_spawn_task", lambda *_args, **_kwargs: 4321)
    assert kb._default_spawn(task, str(tmp_path), board="default") == 4321


def test_hermes_workspace_write_fails_closed_without_a_real_sandbox(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("BENAIAH_MISSION_HERMES_BIN", "/bin/true")
    mission = missions.Mission(
        id="m_test",
        task_id="t_test",
        title="test",
        objective="test",
        success_criteria="done",
        status="queued",
        worker_runtime="hermes",
        selected_worker_runtime=None,
        worker_profile="default",
        verifier_runtime="none",
        selected_verifier_runtime=None,
        intelligence_tier="high",
        permission_mode="workspace_write",
        allowed_tools=[],
        verification_commands=[],
        max_runtime_seconds=30,
        max_retries=0,
        max_cost_gbp_micros=None,
        created_by=None,
        created_at=1,
        updated_at=1,
        started_at=None,
        completed_at=None,
        approved_at=None,
        current_phase=None,
        current_attempt=0,
        last_error=None,
        receipt=None,
    )

    try:
        mission_worker.select_worker(mission, tmp_path)
    except RuntimeError as exc:
        assert "cannot yet enforce" in str(exc)
    else:
        raise AssertionError("Hermes widened a workspace-only Mission")


def test_pro_mission_selects_the_paid_managed_cli_tier(tmp_path, monkeypatch):
    monkeypatch.setenv("BENAIAH_MISSION_CODEX_BIN", "/bin/true")
    mission = missions.Mission(
        id="m_test",
        task_id="t_test",
        title="test",
        objective="test",
        success_criteria="done",
        status="queued",
        worker_runtime="codex",
        selected_worker_runtime=None,
        worker_profile="default",
        verifier_runtime="none",
        selected_verifier_runtime=None,
        intelligence_tier="pro",
        permission_mode="workspace_write",
        allowed_tools=[],
        verification_commands=[],
        max_runtime_seconds=30,
        max_retries=0,
        max_cost_gbp_micros=None,
        created_by=None,
        created_at=1,
        updated_at=1,
        started_at=None,
        completed_at=None,
        approved_at=None,
        current_phase=None,
        current_attempt=0,
        last_error=None,
        receipt=None,
    )

    command = mission_worker._worker_command(
        "codex", mission, tmp_path, "prompt", tmp_path / "out"
    )
    assert command[command.index("-m") + 1] == "benaiah-capability"
    assert mission_worker.effective_managed_cli_tier(mission) == "pro"


def test_unavailable_future_target_records_the_effective_high_tier():
    mission = missions.Mission(
        id="m_test",
        task_id="t_test",
        title="test",
        objective="test",
        success_criteria="done",
        status="queued",
        worker_runtime="codex",
        selected_worker_runtime=None,
        worker_profile="default",
        verifier_runtime="none",
        selected_verifier_runtime=None,
        intelligence_tier="extra_high",
        permission_mode="workspace_write",
        allowed_tools=[],
        verification_commands=[],
        max_runtime_seconds=30,
        max_retries=0,
        max_cost_gbp_micros=None,
        created_by=None,
        created_at=1,
        updated_at=1,
        started_at=None,
        completed_at=None,
        approved_at=None,
        current_phase=None,
        current_attempt=0,
        last_error=None,
        receipt=None,
    )

    assert mission_worker.effective_managed_cli_tier(mission) == "high"
