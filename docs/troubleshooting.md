# Troubleshooting

## Saved key couldn't be unlocked

You see **"Nexio could not unlock your saved API key. Enter it again in
Settings."** (run view, with Open Settings + Retry) or a Settings notice
under the API key field. Nothing is stuck: the run ended, no spinner is
left behind.

1. Open Settings, paste the key again, Save. The old blob is overwritten.
2. Send the prompt again (or press Retry in the run / footer).

Why it happens: API keys are encrypted with an OS key (Windows DPAPI key in
`<userData>\Local State`, macOS Keychain item `<App> Safe Storage`). Anything
that changes that key orphans the saved blobs:

- A different Windows user or machine, a restored backup, or a deleted
  `Local State` file.
- On macOS, a renamed or re-signed app (the Keychain item belongs to the old
  name); on Linux, no keyring / `basic_text` backend.

Moving between users or machines: re-enter keys on the new side. There is no
automatic secret export; settings other than secrets move with the database
file.

## A run shows an error with Retry and Details

Every failed run ends with exactly one error row: a friendly one-line message
in red, [Retry], and a [Details] toggle with redacted technical text (paths
and key-like values masked, hidden by default). Spinners always stop; the
footer shows Retry + Esc-clear for a failed run, Stop + Esc while running,
and the idle hints when done. If you ever see a spinner next to an error,
that is a bug — report it with the Details text.

## Network / provider errors

- "Could not reach the provider" — network, proxy, or base URL. Custom
  providers: check the base URL in Settings.
- "The provider rejected the API key" — wrong or revoked key; re-enter it.
- "Rate-limiting" — wait and Retry.
- "Took too long" — the 60 s watchdog fired; Retry, or Stop a hung run.
