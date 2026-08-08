import json
import sqlite3

from hermes_cli import config
from hermes_cli.observability import benaiah_outcome_relay as relay


def _enable(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(
        config,
        "read_raw_config_readonly",
        lambda: {
            "model": {
                "base_url": "https://benaiah.ai/api/cli/v1/desktop",
                "api_key": "bna_guest_test-token",
            }
        },
    )
    monkeypatch.setattr(relay, "_start_worker", lambda: None)
    relay._TASKS.clear()
    relay._MODEL_CALLS.clear()
    relay._TOOL_CALLS.clear()


def _payloads(tmp_path):
    path = tmp_path / "telemetry" / "benaiah_outcomes" / "relay.sqlite3"
    with sqlite3.connect(path) as connection:
        return [
            json.loads(row[0])
            for row in connection.execute(
                "SELECT payload FROM outbox ORDER BY created_at"
            )
        ]


def test_managed_config_enables_account_scoped_relay(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    endpoint, token = relay._credentials()
    assert endpoint == "https://benaiah.ai/api/cli/v1/outcomes"
    assert token == "bna_guest_test-token"


def test_task_lifecycle_is_durable_content_free_and_idempotent(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    relay.start_task_run(session_id="session", task_id="task-1", platform="desktop")
    relay.start_task_run(session_id="session", task_id="task-1", platform="desktop")
    relay.finish_task_run(
        session_id="session",
        task_id="task-1",
        platform="desktop",
        result={"completed": True, "private": "must never be copied"},
    )
    payloads = _payloads(tmp_path)
    assert (
        len([
            item
            for item in payloads
            if item.get("kind") == "run" and item["input"]["status"] == "started"
        ])
        == 1
    )
    terminal = next(
        item
        for item in payloads
        if item.get("kind") == "run" and item["input"]["status"] == "completed"
    )
    encoded = json.dumps(terminal)
    assert "must never be copied" not in encoded
    assert not {
        "prompt",
        "response",
        "content",
        "command",
        "args",
        "path",
        "url",
        "error_message",
    }.intersection(terminal["input"])


def test_model_and_tool_hooks_emit_only_bounded_child_events(monkeypatch, tmp_path):
    _enable(monkeypatch, tmp_path)
    relay.start_task_run(session_id="session", task_id="task-2", platform="desktop")
    relay.observe_lifecycle(
        "pre_api_request",
        task_id="task-2",
        api_request_id="model-call-1",
        prompt="private prompt",
    )
    relay.observe_lifecycle(
        "post_api_request",
        task_id="task-2",
        api_request_id="model-call-1",
        response="private response",
    )
    relay.observe_lifecycle(
        "pre_tool_call",
        task_id="task-2",
        tool_call_id="tool-call-1",
        args={"path": "/private/file"},
    )
    relay.observe_lifecycle(
        "post_tool_call",
        task_id="task-2",
        tool_call_id="tool-call-1",
        status="ok",
        result="private result",
        duration_ms=12,
    )
    trace_payloads = [
        item for item in _payloads(tmp_path) if item.get("kind") == "event"
    ]
    assert {item["input"]["eventType"] for item in trace_payloads} == {
        "model_call_started",
        "model_call_completed",
        "tool_call_started",
        "tool_call_completed",
    }
    encoded = json.dumps(trace_payloads)
    assert "private prompt" not in encoded
    assert "private response" not in encoded
    assert "/private/file" not in encoded
    assert "private result" not in encoded


def test_non_benaiah_provider_never_enables_native_relay(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(
        config,
        "read_raw_config_readonly",
        lambda: {"model": {"base_url": "https://example.com/v1", "api_key": "secret"}},
    )
    assert relay.enabled() is False


def test_mission_lifecycle_preserves_product_classification_without_content(
    monkeypatch, tmp_path
):
    _enable(monkeypatch, tmp_path)
    relay.start_task_run(
        session_id="",
        task_id="m_public-id",
        platform="mission-control",
        feature="missions",
        task_class="mission",
        auto_tier="extra_high",
    )
    relay.finish_task_run(
        session_id="",
        task_id="m_public-id",
        platform="mission-control",
        result={"completed": True, "objective": "private objective"},
    )
    runs = [item for item in _payloads(tmp_path) if item.get("kind") == "run"]
    assert {item["input"]["feature"] for item in runs} == {"missions"}
    assert {item["input"]["taskClass"] for item in runs} == {"mission"}
    assert {item["input"]["autoTier"] for item in runs} == {"extra_high"}
    assert "private objective" not in json.dumps(runs)
