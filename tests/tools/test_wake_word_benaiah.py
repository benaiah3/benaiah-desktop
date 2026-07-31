"""Benaiah-specific wake-word contract tests (no microphone or network)."""

from pathlib import Path

import tools.wake_word as wake


def test_benaiah_defaults_use_trained_openwakeword_model(monkeypatch):
    monkeypatch.setattr(
        "hermes_cli.config.load_config",
        lambda: {
            "wake_word": {
                "enabled": False,
                "surface": "gui",
                "provider": "openwakeword",
                "phrase": "hey benaiah",
                "start_new_session": True,
                "openwakeword": {"model": "hey_hermes"},
            }
        },
    )
    config = wake.load_wake_word_config()
    assert config["enabled"] is False
    assert config["provider"] == "openwakeword"
    assert wake.wake_phrase(config) == "hey benaiah"
    assert config["start_new_session"] is True
    assert (Path(__file__).resolve().parents[2] / "tools" / "wakewords" / "hey_hermes.tflite").is_file()
    assert (Path(__file__).resolve().parents[2] / "tools" / "wakewords" / "hey_hermes.onnx").is_file()


def test_benaiah_wake_is_scoped_to_desktop_by_default():
    config = {"enabled": True, "surface": "gui"}
    assert wake.wake_surface_enabled("gui", config) is True
    assert wake.wake_surface_enabled("tui", config) is False
    assert wake.wake_surface_enabled("cli", config) is False


def test_sensitivity_is_safely_clamped():
    assert wake._sensitivity({"sensitivity": 3}) == 1.0
    assert wake._sensitivity({"sensitivity": -1}) == 0.0


def test_benaiah_phrase_is_used_verbatim():
    assert wake.wake_phrase({"phrase": "hey benaiah"}) == "hey benaiah"


def test_disabled_wake_never_claims_a_surface():
    assert wake.wake_surface_enabled("gui", {"enabled": False, "surface": "gui"}) is False
