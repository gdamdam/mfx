# mfx native companion — design

Status: **MVP design, approved for implementation.** Last updated for mfx `0.3.3`.

## What this is (and is not)

The mfx native companion is a **small, headless native process** that gives musicians a
**low-latency local audio I/O engine** for playing through an mfx-style effect chain with
CoreAudio/ASIO/WASAPI/JACK-class buffers. It is controlled from the existing mfx browser app
over localhost.

It is **not** a replacement for the browser app. The browser remains the rich UI, patch editor,
preset/share surface, and browser-native processor (25 pedals, XY pad, macros, WAV capture). The
companion exists for the one thing the browser genuinely cannot do: deliver hardware-pedal latency.

> The browser round-trip is ~10–30 ms — a platform floor no web app can beat. Native CoreAudio at a
> 128-frame buffer @ 48 kHz is a few ms per buffer. The companion makes that difference real instead
> of pretending Web Audio can be tuned into it.

## Design decisions

| Question | Decision | Notes |
| --- | --- | --- |
| Subfolder or new repo? | **`mfx/native-companion/`** | MVP lives in-repo; splitting to its own repo is deferred until it needs an independent release cadence. |
| Platforms in MVP? | **macOS first** (CoreAudio via cpal) | Architecture is cross-platform from day one — cpal already abstracts WASAPI/ALSA/JACK — but only macOS is *tested* and *claimed* for the MVP. |
| Audio backend? | **Rust + `cpal` 0.18** | Cross-platform host/device enumeration and duplex streams. Platform-specific low-latency (ASIO, JACK) is deferred. |
| UI shell? | **None in MVP (headless binary).** | Unlike the mpump link-bridge (Tauri window), the companion has no native UI. The browser mfx UI controls it. A tray/status window is an optional later addition. |
| Localhost protocol? | **WebSocket + JSON on `127.0.0.1`**, versioned handshake (`protocol: 1`). | Text frames, `type`-tagged messages. See "Protocol". |
| Bind address? | **`127.0.0.1` only** (loopback). | Deliberately *narrower* than the mpump link-bridge, which binds `0.0.0.0` (whole LAN). No network exposure beyond loopback in the MVP. |
| Discovery? | User starts the companion; the browser **probes a fixed loopback port** (`127.0.0.1:8730`) and completes the `hello`/`welcome` handshake. | No mDNS/bonjour in MVP. If the port is taken the companion exits with a clear message rather than roaming. |
| Patch contract sharing? | **Hand-maintained native subset.** The companion re-declares the subset of `contracts.ts` params it supports, in Rust, and clamps every value. | We do **not** run TypeScript DSP inside Rust and do **not** auto-generate a schema for the MVP. The browser sends a sanitized subset; the companion clamps again (untrusted input). |
| DSP in MVP? | passthrough + input gain + wet/dry + **drive, filter, compressor, delay, tremolo, reverb** + always-last limiter. | 6 effects, not all 25. A tight loop with a few good effects beats a huge incomplete port. |
| Latency target? | **< 12 ms output latency** at 128 frames @ 48 kHz on a wired interface, measurably lower than the browser on the same machine. | See "Latency & measurement". |

### Async runtime / crate choices (match suite precedent)

The mpump link-bridge (`../mpump/link-bridge`) is the suite precedent for a localhost bridge. The
companion reuses the same control-plane stack so the suite stays consistent, and adds `cpal`:

```
tokio             = { version = "1", features = ["rt-multi-thread", "macros", "sync", "net", "time"] }
tokio-tungstenite = "0.24"
futures-util      = "0.3"
serde             = { version = "1", features = ["derive"] }
serde_json        = "1"
cpal              = "0.18"
```

Deliberately **dropped** vs mpump: `tauri`/`tauri-build` (no window) and `rusty_link` (no Ableton
Link in the companion). `tokio` uses a scoped feature set rather than `full`.

Rationale for keeping tokio (vs a sync `tungstenite` thread): the audio stream runs on cpal's own
real-time callback thread regardless of the control runtime, so the WebSocket side only needs to be
correct and simple. Matching the suite's tokio/tungstenite idiom (internally-tagged serde enums,
socket-free pure decision functions for unit tests) is worth more than shaving the dependency.

## Process & threading model

```
                       ┌──────────────── native companion process ────────────────┐
 browser mfx tab       │                                                            │
 (localhost WS)  ◄────►│  tokio: WS server @ 127.0.0.1:8730                         │
                       │      • handshake (hello → welcome)                         │
                       │      • parse+clamp control messages                        │
                       │      • push config snapshots (atomics / triple-buffer)     │
                       │      • broadcast status/devices/error frames               │
                       │                        │ lock-free handoff                 │
                       │                        ▼                                   │
                       │  cpal real-time audio callback thread                      │
                       │      in device → inputGain → [drive→filter→comp→delay→     │
                       │      tremolo→reverb] (wet) → dry/wet mix → limiter →       │
                       │      out device.   NO alloc, NO locks in this thread.      │
                       └────────────────────────────────────────────────────────────┘
```

- **No allocation in the audio callback.** All DSP buffers (delay lines, reverb combs) are sized and
  allocated when a stream is (re)built, never inside the per-block callback.
- **No locks in the hot path.** Control changes reach the audio thread via a lock-free snapshot: a
  double/triple-buffered `ProcessConfig` published by the WS thread and picked up by the audio
  thread, plus atomics for cheap flags (`bypass`, `panic`). No `Mutex` in the callback.
- **Rebuild vs update.** Device/sample-rate/buffer changes tear down and rebuild the cpal stream (off
  the audio thread). Patch/gain/bypass changes are hot and applied via the snapshot.

## Protocol

Versioned JSON, `type`-tagged (serde internally-tagged enums), text frames, `protocol: 1`.

**Browser → companion**

```json
{ "type": "hello", "client": "mfx", "protocol": 1 }
{ "type": "listDevices" }
{ "type": "setAudio", "inputDeviceId": "…", "outputDeviceId": "…", "sampleRate": 48000, "bufferFrames": 128 }
{ "type": "setPatch", "patch": { "inputGain": 1.0, "mix": 1.0, "slots": [ { "id": "drive", "enabled": true, "params": { "drive": 0.4 } } ] } }
{ "type": "setBypass", "bypass": false }
{ "type": "panic" }
```

**Companion → browser**

```json
{ "type": "welcome", "protocol": 1, "version": "0.1.0", "capabilities": ["native-audio", "effect-subset-v1"] }
{ "type": "devices", "inputs": [ { "id": "…", "name": "…" } ], "outputs": [ { "id": "…", "name": "…" } ] }
{ "type": "status", "running": true, "sampleRate": 48000, "bufferFrames": 128, "estimatedLatencyMs": 8.4, "xruns": 0, "bypass": false }
{ "type": "error", "message": "…" }
```

**Handshake / versioning** (mirrors the mbus convention): the browser sends `hello` with its highest
`protocol`; the companion replies `welcome` with `min(client, companion)` and its `capabilities`. A
client that never receives `welcome` within a short timeout treats the endpoint as absent/too-old and
degrades gracefully. Unknown message *types* are dropped silently both directions (forward-compat);
unknown *fields* are ignored.

**Trust boundary.** All browser-provided data is untrusted. Every numeric value is clamped to the
native subset's declared range and finite-checked before it can reach the DSP — the same discipline
as the browser's `sanitizePatch`, re-implemented in Rust. Unknown effect ids and duplicate slots are
dropped. `bufferFrames`/`sampleRate` are clamped to device-supported ranges.

### Native patch subset (`effect-subset-v1`)

The companion accepts a **subset** of the browser `Patch`. Fields it doesn't understand are ignored.
Parameter names align with `contracts.ts` where practical; not every browser param is honored in the
MVP.

| Effect | Params honored (name, range) |
| --- | --- |
| `inputGain` | 0..3 (linear, top-level) |
| `mix` | 0..1 (master dry/wet, top-level) |
| `drive` | drive 0..1, tone 0..1, level 0..1, character 0..6 (voice index) |
| `filter` | freq 30..18000, reso 0..1, type 0..3 (LP/BP/HP/NT), model 0..0 (SVF only in MVP), drive 0..1 |
| `comp` | amount 0..1, attack 0..1, release 0..1, makeup 0..1, mix 0..1 |
| `delay` | time 0.02..1.5, feedback 0..0.95, mix 0..1, tone 0..1 |
| `tremolo` | rate 0.1..16, depth 0..1, shape 0..1 |
| `reverb` | size 0..1, decay 0..1, mix 0..1, damp 0..1 |
| limiter | always last; hard safety clamp, not user-facing in MVP |

The filter ships the **SVF** model only in the MVP; ladder/diode/comb are deferred. Discrete params
(voice/type) are rounded to integer indices, matching the browser sanitizer.

## Latency & measurement

- **Config-reported estimate.** The companion reports `estimatedLatencyMs` derived from the negotiated
  cpal buffer size and sample rate: `(inputBufferFrames + outputBufferFrames) / sampleRate * 1000`,
  plus any host-reported device latency cpal exposes. This is honest about being an *estimate*.
- **Target.** At 128 frames @ 48 kHz, the per-buffer time is ~2.67 ms; a duplex in+out path targets
  **< 12 ms** output latency on a wired interface — comfortably under the browser's 10–30 ms floor on
  the same machine.
- **Measurement plan (manual QA).**
  1. Report and log the negotiated buffer/sample-rate and the derived estimate.
  2. **Physical loopback:** patch the interface output to its input with a cable, send a click, record
     the return, and measure the sample offset → true round-trip latency. Documented in the companion
     README as the ground-truth check.
  3. Compare against the browser's reported round-trip on the same machine/interface.
- **Honesty rule.** The companion README and status must not claim a latency figure it hasn't
  measured; the config estimate is labeled as an estimate, and the loopback number as measured.

## xruns / glitch accounting

cpal surfaces stream errors via the error callback but does not universally expose device xrun
counters across backends. MVP policy: maintain an `xruns` counter incremented on cpal error callbacks
and on detectable buffer-timing anomalies where the backend provides timestamps; report it in
`status`. Document that on some backends this is a *callback-error* count, not a hardware xrun count.

## Browser integration (overview; detail in Task D)

- A small client under `src/native/` tries the loopback endpoint and runs the handshake.
- The transport area gains a **Native I/O** connection indicator + mode toggle, modeled on the
  existing Ableton-Link control (`LinkStatus {connected, peers, following}` + `onToggleLink` in the
  `.tp-tempo` group of `TransportBar.tsx`) — that prop pair is the template.
- Two engine modes: **Browser engine** (unchanged default) vs **Native companion**. Browser
  processing is never removed; native mode is optional and degrades gracefully when the companion is
  absent (same pattern as the optional mbus input / Link tempo-follow).
- The browser sends the sanitized native patch subset and displays native latency/xrun status.

## Security

- Binds **`127.0.0.1` only**. No LAN exposure, no remote control by default.
- No authentication in the MVP is acceptable *because* the surface is loopback-only and the companion
  performs only local audio I/O; this is called out in the README. Any future non-loopback binding
  must add an auth/handshake token first — explicitly deferred.
- All control input is clamped/finite-checked before reaching DSP.

## Versioning

The browser app (`mfx`, currently `0.3.3`) and the companion (`0.1.0`) version **independently**. The
`welcome` handshake carries the companion `version` and negotiates the wire `protocol` integer; the
browser keys compatibility off `protocol`, not the companion's semver.

## Explicitly deferred

All 25 effects · preset-perfect parity with browser mfx · filter models beyond SVF · mobile · plugin
hosting · AU/VST · Tauri packaging & signed installers · tray/status window · remote/LAN control ·
sample-accurate sync with mbus · publishing companion audio as an mbus source · mDNS discovery ·
auto-generated schema from `contracts.ts` · ASIO/JACK-specific low-latency backends (cpal's default
host only in MVP).

## Stop conditions (from the brief)

Stop and report if: cpal cannot provide stable low-latency I/O on the target machine; the audio
callback needs unsafe/locking architecture that can't be justified; browser/native patch parity
becomes a large rewrite; platform packaging dominates the MVP; or gates fail outside scope. Never
present the companion as complete until measured audio I/O exists.
