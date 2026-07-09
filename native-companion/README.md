# mfx native companion

A small, **headless** native process that gives mfx a **low-latency local audio I/O
engine** — CoreAudio/ASIO/WASAPI/JACK-class buffers — controlled from the mfx browser
app over localhost.

It is **not** a replacement for the browser app. The browser remains the UI, patch
editor, preset/share surface, and its own processor. The companion exists for the one
thing a browser cannot do: **hardware-pedal latency**.

> **Latency honesty.** The browser audio round-trip is a ~10–30 ms platform floor no web
> app can beat. Native CoreAudio at a 128-frame buffer @ 48 kHz is a few ms per buffer.
> This companion makes that difference real. But it does **not** claim a latency figure it
> hasn't measured: the number it reports over the wire is a *config-derived estimate*
> (`(inputBuffer + outputBuffer) / sampleRate`). The ground-truth figure comes from the
> physical-loopback measurement described below — until that is run on your machine, treat
> the reported figure as an estimate, not a guarantee.

See [`../docs/native-companion-design.md`](../docs/native-companion-design.md) for the full
design, protocol, and the list of what is deliberately deferred.

## Status

- **Platform:** macOS-first (CoreAudio via [`cpal`](https://crates.io/crates/cpal)). The
  architecture is cross-platform, but only macOS is tested and claimed for the MVP.
- **Scope so far:** localhost WebSocket control plane, device enumeration, and the pure DSP
  cores (gain, safety limiter). The real-time duplex audio stream and the effect subset land
  in the subsequent tasks.

## Build & run

Requires a Rust toolchain (`rustup`, stable).

```bash
cd native-companion
cargo run                 # listens on ws://127.0.0.1:8730 (loopback only)
cargo run -- --port 8931  # or set MFX_COMPANION_PORT
```

Then, in the mfx browser app, switch the input mode to **Native companion** — it probes the
loopback port and connects. The companion binds `127.0.0.1` only: no LAN exposure, no remote
control.

## Gate

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Protocol (summary)

Versioned JSON over WebSocket, `type`-tagged, `protocol: 1`. Browser sends
`hello` / `listDevices` / `setAudio` / `setPatch` / `setBypass` / `panic`; the companion
replies `welcome` / `devices` / `status` / `error`. All browser-provided values are
untrusted and clamped at the boundary (`protocol::sanitize_patch`). Full message shapes are
in the design doc.

## Measuring latency (ground truth)

1. Note the companion's reported `estimatedLatencyMs` for your negotiated buffer/sample-rate.
2. **Physical loopback:** patch your interface's output to its input with a cable, play a
   click, record the return, and measure the sample offset → true round-trip latency.
3. Compare against the browser's reported round-trip on the same machine/interface.

## Security

Loopback-only (`127.0.0.1`). No authentication in the MVP is acceptable *because* the surface
is local audio I/O over loopback; any future non-loopback binding must add an auth handshake
first (explicitly deferred).

## License

[AGPL-3.0-or-later](../LICENSE), matching the rest of mfx and the m-suite.
