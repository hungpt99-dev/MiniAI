# Changelog

## Unreleased

- Provider robustness overhaul: per-provider adapters
  (`src/main/ai/providers/<id>/{adapter,capabilities,errors}.ts`) with a
  neutral request boundary, data-driven capabilities, one-shot 400/422
  parameter recovery (30-day cache + Reset fixes), bounded 429/5xx backoff
  (non-streaming only), and normalized error kinds with friendly messages.
- Settings Test button now uses unsaved values (listModels → tiny completion
  → tool probe), shows inline success/failure, aborts at 15 s; model input
  suggests names from `listModels`; new `sendTemperature` toggle for Custom.
- Conformance suite runs identical mocked-HTTP scenarios per adapter plus a
  literal-contract test; see `docs/providers.md`.
