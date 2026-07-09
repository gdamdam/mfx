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

- **Platform:** macOS-first (CoreAudio via [`cpal`](https://crates.io/crates/cpal) 0.18). The
  architecture is cross-platform (cpal abstracts WASAPI/ALSA/JACK), but **only macOS is a
  build target for the MVP and no platform has completed on-device audio QA yet** — see below.
- **Implemented:** localhost WebSocket control plane + versioned handshake; device
  enumeration; a lock-free duplex audio engine (cpal input→ring→output, wait-free config
  snapshot, no allocation/locks in the callback); the effect subset (drive, filter,
  compressor, delay, tremolo, reverb) plus an always-last safety limiter; and browser control
  from the mfx transport bar.
- **Verified so far:** the pure DSP cores, the sanitizer/trust boundary, and the WebSocket
  handshake are covered by unit + integration tests (`cargo test`, `npm run test`). The
  real-time audio path **compiles** against cpal 0.18 but has **not** been exercised on real
  audio hardware in this environment.
- **Not yet verified (blocking a "done" claim):** measured, glitch-free audio I/O on a real
  device, and a measured latency figure. Until the on-device QA below is run and its results
  recorded here, treat native audio as *implemented but unproven*. Per the design brief, the
  companion is not "complete" until measured audio I/O exists.

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

## On-device QA checklist (macOS)

These require real audio hardware and cannot run in CI/headless — run them on a Mac with a
wired interface and record the results here before claiming native audio works.

- [ ] **Enumeration** — `listDevices` returns the expected inputs/outputs; the browser's
      Native panel shows the companion connected.
- [ ] **Passthrough** — with an empty rack, input reaches output at a sane level, no glitches.
- [ ] **Effect chain** — enabling drive/filter/comp/delay/tremolo/reverb audibly changes the
      signal; a musically useful chain (e.g. drive → filter → delay → reverb) sounds right.
- [ ] **Bypass safety** — toggling bypass does **not** blast the output (limiter holds).
- [ ] **Panic** — `panic` silences immediately; re-selecting Native resumes.
- [ ] **Device loss** — unplugging the interface does not crash the companion (error logged,
      `xruns`/stream-error surfaced); reconnecting via `setAudio` recovers.
- [ ] **xruns** — the reported `xruns` count stays at/near 0 at the chosen buffer size.
- [ ] **Latency** — the config estimate is sane, and the measured loopback figure (below) is
      **lower than the browser's reported round-trip on the same machine** (or documented why not).

## Measuring latency (ground truth)

1. Note the companion's reported `estimatedLatencyMs` for your negotiated buffer/sample-rate.
2. **Physical loopback:** patch your interface's output to its input with a cable, play a
   click, record the return, and measure the sample offset → true round-trip latency.
3. Compare against the browser's reported round-trip on the same machine/interface.

## Packaging & release boundary

- **MVP ships as source**, run via `cargo run`. No Tauri packaging, no tray/status window, and
  no signed installers in the MVP — all deferred (see the design doc).
- **Versioning is independent.** The companion (`0.1.1`) versions separately from the browser
  app (`mfx`). The browser keys compatibility off the wire `protocol` integer negotiated in the
  `welcome` handshake, not the companion's semver.
- **No production-support claims** are made for any platform that hasn't completed the on-device
  QA above. macOS is the only build target exercised for the MVP.

## Security

Loopback-only (`127.0.0.1`). No LAN exposure and no remote control by default. No authentication
in the MVP is acceptable *because* the surface is local audio I/O over loopback; any future
non-loopback binding must add an auth handshake first (explicitly deferred).

## License

[AGPL-3.0-or-later](../LICENSE), matching the rest of mfx and the m-suite.
