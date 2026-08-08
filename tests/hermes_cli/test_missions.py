from __future__ import annotations

from pathlib import Path

from hermes_cli import kanban_db as kb
from hermes_cli import missions


def test_full_access_is_not_dispatchable_until_explicit_approval(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with kb.connect_closing() as conn:
        mission = missions.create_mission(
            conn,
            objective="Prepare the release",
            success_criteria="Release evidence exists",
            permission_mode="full_access",
            workspace_path=str(workspace),
        )
        task = kb.get_task(conn, mission.task_id)
        assert mission.status == "awaiting_approval"
        assert mission.approved_at is None
        assert task is not None and task.status == "blocked"

        approved = missions.approve_mission(conn, mission.id)
        task = kb.get_task(conn, mission.task_id)
        assert approved.status == "queued"
        assert approved.approved_at is not None
        assert task is not None and task.status == "ready"


def test_pause_resume_cancel_keep_mission_and_task_in_lockstep(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with kb.connect_closing() as conn:
        mission = missions.create_mission(
            conn,
            objective="Write a local report",
            success_criteria="report.md exists",
            workspace_path=str(workspace),
        )
        paused = missions.pause_mission(conn, mission.id)
        assert paused.status == "paused"
        assert kb.get_task(conn, mission.task_id).status == "scheduled"

        resumed = missions.resume_mission(conn, mission.id)
        assert resumed.status == "queued"
        assert kb.get_task(conn, mission.task_id).status == "ready"

        cancelled = missions.cancel_mission(conn, mission.id)
        assert cancelled.status == "cancelled"
        assert cancelled.receipt["status"] == "cancelled"
        assert kb.get_task(conn, mission.task_id).status == "archived"


def test_idempotency_returns_the_original_mission(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with kb.connect_closing() as conn:
        first = missions.create_mission(
            conn,
            objective="Index the repository",
            success_criteria="Index can be queried",
            workspace_path=str(workspace),
            idempotency_key="index-v1",
        )
        second = missions.create_mission(
            conn,
            objective="Index the repository",
            success_criteria="Index can be queried",
            workspace_path=str(workspace),
            idempotency_key="index-v1",
        )
        assert second.id == first.id
        assert second.task_id == first.task_id
        assert len(missions.list_missions(conn)) == 1


def test_permission_and_tier_names_accept_product_hyphens(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with kb.connect_closing() as conn:
        mission = missions.create_mission(
            conn,
            objective="Check the workspace",
            success_criteria="A result is recorded",
            workspace_path=str(workspace),
            permission_mode="read-only",
            intelligence_tier="extra-high",
        )
        assert mission.permission_mode == "read_only"
        assert mission.intelligence_tier == "extra_high"


def test_read_reconciles_a_stopped_supervisor_back_to_queue(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with kb.connect_closing() as conn:
        mission = missions.create_mission(
            conn,
            objective="Generate an artifact",
            success_criteria="The artifact is verified",
            workspace_path=str(workspace),
        )
        claimed = kb.claim_task(conn, mission.task_id, claimer="test-host:9")
        assert claimed is not None
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE missions SET status='running' WHERE id=?", (mission.id,)
            )
        assert kb.reclaim_task(conn, mission.task_id, signal_fn=lambda *_args: None)

        repaired = missions.get_mission(conn, mission.id)
        assert repaired.status == "queued"
        assert repaired.current_phase == "dispatch"
        assert "stopped" in repaired.last_error.lower()


def test_create_rejects_a_permission_boundary_the_worker_cannot_enforce(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    with kb.connect_closing() as conn:
        try:
            missions.create_mission(
                conn,
                objective="Edit a report",
                success_criteria="The report is updated",
                worker_runtime="hermes",
                permission_mode="workspace_write",
                workspace_path=str(workspace),
            )
        except ValueError as exc:
            assert "cannot yet enforce" in str(exc)
        else:
            raise AssertionError(
                "Mission accepted an unenforceable permission boundary"
            )


def test_blank_workspace_creates_a_managed_scratch_task(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    with kb.connect_closing() as conn:
        mission = missions.create_mission(
            conn,
            objective="Prepare a private draft",
            success_criteria="The draft is independently verified",
            workspace_kind="scratch",
            workspace_path=None,
        )
        task = kb.get_task(conn, mission.task_id)

        assert task is not None
        assert task.workspace_kind == "scratch"
        assert task.workspace_path is None
