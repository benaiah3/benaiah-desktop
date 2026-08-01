"""Per-call desktop voice selection must not rewrite global TTS config."""

import json

from tools import tts_tool


def test_edge_voice_override_is_scoped_to_one_call(monkeypatch, tmp_path):
    configured = {"provider": "edge", "edge": {"voice": "en-GB-SoniaNeural"}}
    seen = {}

    async def generate(_text, output_path, config):
        seen["voice"] = config["edge"]["voice"]
        with open(output_path, "wb") as handle:
            handle.write(b"audio")
        return output_path

    monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: configured)
    monkeypatch.setattr(tts_tool, "_import_edge_tts", lambda: object())
    monkeypatch.setattr(tts_tool, "_generate_edge_tts", generate)

    result = json.loads(
        tts_tool.text_to_speech_tool(
            "Hello",
            output_path=str(tmp_path / "voice.mp3"),
            voice="en-GB-RyanNeural",
        )
    )

    assert result["success"] is True
    assert seen["voice"] == "en-GB-RyanNeural"
    assert configured["edge"]["voice"] == "en-GB-SoniaNeural"
