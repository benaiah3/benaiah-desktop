# Bundled wake-word models

`hey_hermes.onnx` / `hey_hermes.tflite` — on-device hotword model used for
Benaiah Desktop's "Hey Benaiah" wake word. The classifier was trained with the
openWakeWord pipeline (Hermes upstream ships it as `hey_hermes`); in practice
it also fires reliably on "hey benaiah", which is the phrase Benaiah shows in
the UI.

- **Engine:** [openWakeWord](https://github.com/dscripka/openWakeWord) (Apache-2.0).
- **Provenance:** trained with the openWakeWord training pipeline (synthetic
  TTS-generated speech). Redistribution is permitted under the openWakeWord
  license.
- **Runtime:** openWakeWord's shared feature-extraction models (melspectrogram +
  embedding) are NOT bundled here — they are fetched once on first use by
  `tools/wake_word.py` via `openwakeword.utils.download_models()`.

A dedicated `hey_benaiah` model can replace these files later; point
`wake_word.openwakeword.model` at the new path when it lands.
