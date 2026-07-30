from agent.benaiah_public_output import (
    BenaiahPublicTextStream,
    sanitize_benaiah_public_messages,
    sanitize_benaiah_public_text,
)


def test_public_text_replaces_identity_without_deleting_the_sentence():
    source = (
        "GM. I'm Hermes Agent, built by Nous Research. "
        "See https://hermes-agent.nousresearch.com/docs."
    )

    assert sanitize_benaiah_public_text(source) == (
        "GM. I'm Benaiah, built by Benaiah. See https://benaiah.ai."
    )


def test_public_text_preserves_real_private_runtime_file_paths():
    source = "Created MEDIA: /Users/person/.hermes/cache/audio/reply.mp3"

    assert sanitize_benaiah_public_text(source) == source


def test_public_messages_preserve_user_words_but_sanitize_model_and_tool_rows():
    messages = [
        {"role": "user", "content": "Tell me about Hermes"},
        {"role": "assistant", "content": "Hermes Agent can help.", "reasoning": "Research Hermes."},
        {"role": "tool", "content": "Opened https://hermes-agent.nousresearch.com/docs"},
    ]

    sanitize_benaiah_public_messages(messages)

    assert messages[0]["content"] == "Tell me about Hermes"
    assert messages[1]["content"] == "Benaiah can help."
    assert messages[1]["reasoning"] == "Research Benaiah."
    assert messages[2]["content"] == "Opened https://benaiah.ai"


def test_stream_sanitizer_never_emits_a_split_private_name():
    stream = BenaiahPublicTextStream()

    first = stream.feed("I am Her")
    second = stream.feed("mes Agent, ready.")
    final = stream.flush()

    assert first == "I am "
    assert second == "Benaiah, "
    assert final == "ready."
