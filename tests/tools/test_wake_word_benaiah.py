"""Benaiah-specific wake-word contract tests (no microphone or network)."""

from pathlib import Path

import numpy as np

import tools.wake_word as wake


def test_benaiah_defaults_use_stt_phrase_spotting(monkeypatch):
    monkeypatch.setattr(
        "hermes_cli.config.load_config",
        lambda: {
            "wake_word": {
                "enabled": False,
                "surface": "gui",
                "provider": "stt",
                "phrase": "benaiah",
                "start_new_session": True,
            }
        },
    )
    config = wake.load_wake_word_config()
    assert config["enabled"] is False
    assert config["provider"] == "stt"
    assert wake.wake_phrase(config) == "benaiah"
    assert config["start_new_session"] is True
    assert wake._phrase_matched("Benaiah.", "benaiah")
    assert wake._phrase_matched("Benaya.", "benaiah")
    assert wake._phrase_matched("Beniah.", "benaiah")
    assert wake._phrase_matched("Bonita.", "benaiah")
    assert wake._phrase_matched("Benaiah open Gmail", "benaiah")
    assert wake._phrase_matched("Hey Benaiah open Gmail", "benaiah")
    assert not wake._phrase_matched("hey", "benaiah")
    assert not wake._phrase_matched("play some music", "benaiah")
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
    assert wake.wake_phrase({"phrase": "computer"}) == "computer"


def test_legacy_benaiah_default_is_shortened_for_existing_installations(monkeypatch):
    persisted = {"enabled": True, "provider": "stt", "phrase": "hey benaiah"}
    monkeypatch.setattr("hermes_cli.config.load_config", lambda: {"wake_word": persisted})

    effective = wake.load_wake_word_config()

    assert effective["phrase"] == "benaiah"
    assert wake.wake_phrase(persisted) == "benaiah"
    assert persisted["phrase"] == "hey benaiah"


def test_disabled_wake_never_claims_a_surface():
    assert wake.wake_surface_enabled("gui", {"enabled": False, "surface": "gui"}) is False


def test_stt_spotter_waits_for_one_word_to_end_before_transcribing(monkeypatch):
    monkeypatch.setattr(wake, "_stt_ready", lambda: True)
    calls = []

    def transcribe(path):
        calls.append(path)
        return {"success": True, "transcript": "Benaiah"}

    monkeypatch.setattr("tools.transcription_tools.transcribe_audio", transcribe)
    engine = wake._SttPhraseEngine({"phrase": "benaiah", "sensitivity": 0.5})
    speech = np.full(engine.frame_length, 800, dtype=np.int16)
    silence = np.zeros(engine.frame_length, dtype=np.int16)

    assert engine.process(speech) is False
    assert engine.process(silence) is False
    assert engine.process(silence) is False
    assert engine.process(silence) is True
    assert len(calls) == 1


def test_stt_spotter_does_not_transcribe_ambient_silence(monkeypatch):
    monkeypatch.setattr(wake, "_stt_ready", lambda: True)
    monkeypatch.setattr(
        "tools.transcription_tools.transcribe_audio",
        lambda _path: (_ for _ in ()).throw(AssertionError("should not transcribe silence")),
    )
    engine = wake._SttPhraseEngine({"phrase": "computer", "sensitivity": 0.5})
    silence = np.zeros(engine.frame_length, dtype=np.int16)

    for _ in range(30):
        assert engine.process(silence) is False
