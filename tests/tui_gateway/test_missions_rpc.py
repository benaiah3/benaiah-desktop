from __future__ import annotations

import tui_gateway.server as server


def _call(method, params=None):
    response = server._methods[method](1, params or {})
    assert "error" not in response, response.get("error")
    return response["result"]


def test_mission_methods_are_registered_and_mutations_leave_reader_thread():
    for name in (
        "missions.list",
        "missions.get",
        "missions.create",
        "missions.pause",
        "missions.resume",
        "missions.cancel",
        "missions.approve",
        "missions.receipt",
    ):
        assert name in server._methods
    assert {
        "missions.create",
        "missions.pause",
        "missions.cancel",
    } <= server._LONG_HANDLERS


def test_create_get_and_cancel_mission_over_rpc(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    dispatches: list[tuple[object, tuple[str, ...]]] = []
    monkeypatch.setattr(
        server,
        "_mission_dispatch_kick",
        lambda board, task_ids: dispatches.append((board, tuple(task_ids))),
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    created = _call(
        "missions.create",
        {
            "objective": "Create a release note",
            "success_criteria": "release.md exists",
            "workspace_path": str(workspace),
            "worker_runtime": "codex",
            "verifier_runtime": "hermes",
        },
    )["mission"]
    assert created["status"] == "queued"
    assert dispatches == [(None, (created["task_id"],))]
    fetched = _call("missions.get", {"mission_id": created["id"]})["mission"]
    assert fetched["objective"] == "Create a release note"
    cancelled = _call("missions.cancel", {"mission_id": created["id"]})["mission"]
    assert cancelled["status"] == "cancelled"
    assert (
        _call("missions.receipt", {"mission_id": created["id"]})["receipt"]["status"]
        == "cancelled"
    )


def test_approving_a_locked_mission_wakes_its_worker(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    dispatches: list[tuple[object, tuple[str, ...]]] = []
    monkeypatch.setattr(
        server,
        "_mission_dispatch_kick",
        lambda board, task_ids: dispatches.append((board, tuple(task_ids))),
    )
    created = _call(
        "missions.create",
        {
            "objective": "Prepare a full-access release",
            "success_criteria": "The release is ready for review",
            "permission_mode": "full_access",
            "workspace_kind": "scratch",
        },
    )["mission"]

    assert created["status"] == "awaiting_approval"
    assert dispatches == []

    approved = _call("missions.approve", {"mission_id": created["id"]})["mission"]

    assert approved["status"] == "queued"
    assert dispatches == [(None, (created["task_id"],))]
