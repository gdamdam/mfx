//! Wire protocol + the trust boundary.
//!
//! Every value that reaches us from the browser is untrusted. `sanitize_patch`
//! mirrors the browser's `sanitizePatch` (see `src/audio/contracts.ts`): it never
//! panics, clamps every numeric field to the native subset's declared range,
//! rounds discrete/option params to integer indices, and drops unknown effect
//! ids. Non-finite input collapses to the param default (not the range min).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Highest wire protocol this companion speaks. Negotiated down in the handshake.
pub const PROTOCOL_VERSION: u32 = 1;
/// Companion semver, independent of the browser app version.
pub const COMPANION_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Capabilities advertised in `welcome`.
pub fn capabilities() -> Vec<String> {
    vec!["native-audio".into(), "effect-subset-v1".into()]
}

// ---------------------------------------------------------------------------
// Browser -> companion
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    Hello {
        #[serde(default)]
        client: String,
        #[serde(default)]
        protocol: u32,
    },
    #[serde(rename = "listDevices")]
    ListDevices,
    #[serde(rename = "setAudio", rename_all = "camelCase")]
    SetAudio {
        #[serde(default)]
        input_device_id: Option<String>,
        #[serde(default)]
        output_device_id: Option<String>,
        #[serde(default)]
        sample_rate: Option<u32>,
        #[serde(default)]
        buffer_frames: Option<u32>,
    },
    #[serde(rename = "setPatch")]
    SetPatch { patch: RawPatch },
    #[serde(rename = "setBypass")]
    SetBypass { bypass: bool },
    #[serde(rename = "panic")]
    Panic,
}

/// The raw, untrusted patch subset as it arrives on the wire. Unknown fields are
/// ignored; unknown effect ids survive here and are dropped in `sanitize_patch`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPatch {
    #[serde(default)]
    pub input_gain: Option<f64>,
    #[serde(default)]
    pub mix: Option<f64>,
    #[serde(default)]
    pub slots: Vec<RawSlot>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawSlot {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub params: HashMap<String, f64>,
}

// ---------------------------------------------------------------------------
// Companion -> browser
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    Welcome {
        protocol: u32,
        version: String,
        capabilities: Vec<String>,
    },
    Devices {
        inputs: Vec<DeviceInfo>,
        outputs: Vec<DeviceInfo>,
    },
    #[serde(rename_all = "camelCase")]
    Status {
        running: bool,
        sample_rate: u32,
        buffer_frames: u32,
        estimated_latency_ms: f32,
        xruns: u64,
        bypass: bool,
    },
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Sanitized, DSP-facing config (the clamped subset)
// ---------------------------------------------------------------------------

/// A clamped, ready-to-run effect. Order in `SanitizedPatch::effects` is the
/// signal-chain order; only enabled, recognized effects are included.
#[derive(Debug, Clone, PartialEq)]
pub enum EffectParams {
    Drive {
        drive: f32,
        tone: f32,
        level: f32,
        /// Voice index 0..=6 (Soft, Hard, Tube, Tape, Germ, Si, Fold).
        character: u8,
    },
    Filter {
        freq: f32,
        reso: f32,
        /// 0=LP, 1=BP, 2=HP, 3=NT.
        ftype: u8,
        drive: f32,
    },
    Comp {
        amount: f32,
        attack: f32,
        release: f32,
        makeup: f32,
        mix: f32,
    },
    Delay {
        time: f32,
        feedback: f32,
        mix: f32,
        tone: f32,
    },
    Tremolo {
        rate: f32,
        depth: f32,
        shape: f32,
    },
    Reverb {
        size: f32,
        decay: f32,
        mix: f32,
        damp: f32,
    },
}

/// Fully clamped patch handed to the audio engine.
#[derive(Debug, Clone, PartialEq)]
pub struct SanitizedPatch {
    /// Input trim, 0..3 linear.
    pub input_gain: f32,
    /// Master dry..wet, 0..1.
    pub mix: f32,
    pub effects: Vec<EffectParams>,
}

impl Default for SanitizedPatch {
    fn default() -> Self {
        SanitizedPatch {
            input_gain: 1.0,
            mix: 1.0,
            effects: Vec::new(),
        }
    }
}

/// Shared, finite-safe clamp. Non-finite input collapses to `default`, matching
/// the browser sanitizer's `Number.isFinite` gate (not to the range min).
fn clampf(v: f64, min: f64, max: f64, default: f64) -> f32 {
    let v = if v.is_finite() { v } else { default };
    v.clamp(min, max) as f32
}

/// Read a continuous param from the raw map with clamping and a default.
fn param(map: &HashMap<String, f64>, key: &str, min: f64, max: f64, default: f64) -> f32 {
    clampf(*map.get(key).unwrap_or(&default), min, max, default)
}

/// Read a discrete/option param as a rounded integer index in `0..=max`.
fn index(map: &HashMap<String, f64>, key: &str, max: u8, default: u8) -> u8 {
    let raw = *map.get(key).unwrap_or(&(default as f64));
    let v = if raw.is_finite() { raw } else { default as f64 };
    v.round().clamp(0.0, max as f64) as u8
}

/// Coerce one untrusted slot into a recognized, clamped effect. Returns `None`
/// for unknown ids so they're dropped from the chain.
fn sanitize_slot(slot: &RawSlot) -> Option<EffectParams> {
    let p = &slot.params;
    Some(match slot.id.as_str() {
        "drive" => EffectParams::Drive {
            drive: param(p, "drive", 0.0, 1.0, 0.4),
            tone: param(p, "tone", 0.0, 1.0, 0.55),
            level: param(p, "level", 0.0, 1.0, 0.85),
            character: index(p, "character", 6, 0),
        },
        "filter" => EffectParams::Filter {
            freq: param(p, "freq", 30.0, 18000.0, 1200.0),
            reso: param(p, "reso", 0.0, 1.0, 0.2),
            ftype: index(p, "type", 3, 0),
            drive: param(p, "drive", 0.0, 1.0, 0.0),
        },
        "comp" => EffectParams::Comp {
            amount: param(p, "amount", 0.0, 1.0, 0.4),
            attack: param(p, "attack", 0.0, 1.0, 0.2),
            release: param(p, "release", 0.0, 1.0, 0.45),
            makeup: param(p, "makeup", 0.0, 1.0, 0.5),
            mix: param(p, "mix", 0.0, 1.0, 1.0),
        },
        "delay" => EffectParams::Delay {
            time: param(p, "time", 0.02, 1.5, 0.3),
            feedback: param(p, "feedback", 0.0, 0.95, 0.4),
            mix: param(p, "mix", 0.0, 1.0, 0.35),
            tone: param(p, "tone", 0.0, 1.0, 0.5),
        },
        "tremolo" => EffectParams::Tremolo {
            rate: param(p, "rate", 0.1, 16.0, 5.0),
            depth: param(p, "depth", 0.0, 1.0, 0.6),
            shape: param(p, "shape", 0.0, 1.0, 0.0),
        },
        "reverb" => EffectParams::Reverb {
            size: param(p, "size", 0.0, 1.0, 0.5),
            decay: param(p, "decay", 0.0, 1.0, 0.5),
            mix: param(p, "mix", 0.0, 1.0, 0.3),
            damp: param(p, "damp", 0.0, 1.0, 0.5),
        },
        _ => return None,
    })
}

/// Turn an untrusted `RawPatch` into a clamped `SanitizedPatch`. Never panics.
/// Disabled slots and unrecognized effect ids are dropped; chain order is kept.
pub fn sanitize_patch(raw: &RawPatch) -> SanitizedPatch {
    SanitizedPatch {
        input_gain: clampf(raw.input_gain.unwrap_or(1.0), 0.0, 3.0, 1.0),
        mix: clampf(raw.mix.unwrap_or(1.0), 0.0, 1.0, 1.0),
        effects: raw
            .slots
            .iter()
            .filter(|s| s.enabled)
            .filter_map(sanitize_slot)
            .collect(),
    }
}

/// Parse an inbound text frame into a `ClientMessage`, or `None` if it's not a
/// recognized message (unknown types are dropped silently, forward-compat).
pub fn parse_client_message(text: &str) -> Option<ClientMessage> {
    serde_json::from_str(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(id: &str, enabled: bool, params: &[(&str, f64)]) -> RawSlot {
        RawSlot {
            id: id.into(),
            enabled,
            params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    #[test]
    fn parses_hello() {
        let m = parse_client_message(r#"{"type":"hello","client":"mfx","protocol":1}"#).unwrap();
        match m {
            ClientMessage::Hello { client, protocol } => {
                assert_eq!(client, "mfx");
                assert_eq!(protocol, 1);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parses_set_audio_camel_case() {
        let m = parse_client_message(
            r#"{"type":"setAudio","inputDeviceId":"in","outputDeviceId":"out","sampleRate":48000,"bufferFrames":128}"#,
        )
        .unwrap();
        match m {
            ClientMessage::SetAudio {
                input_device_id,
                output_device_id,
                sample_rate,
                buffer_frames,
            } => {
                assert_eq!(input_device_id.as_deref(), Some("in"));
                assert_eq!(output_device_id.as_deref(), Some("out"));
                assert_eq!(sample_rate, Some(48000));
                assert_eq!(buffer_frames, Some(128));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn unknown_message_type_is_dropped() {
        assert!(parse_client_message(r#"{"type":"nonsense","x":1}"#).is_none());
        assert!(parse_client_message("not json at all").is_none());
    }

    #[test]
    fn welcome_serializes_to_expected_shape() {
        let msg = ServerMessage::Welcome {
            protocol: PROTOCOL_VERSION,
            version: COMPANION_VERSION.into(),
            capabilities: capabilities(),
        };
        let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "welcome");
        assert_eq!(v["protocol"], 1);
        assert_eq!(v["capabilities"][0], "native-audio");
    }

    #[test]
    fn status_uses_camel_case_fields() {
        let msg = ServerMessage::Status {
            running: true,
            sample_rate: 48000,
            buffer_frames: 128,
            estimated_latency_ms: 8.4,
            xruns: 0,
            bypass: false,
        };
        let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "status");
        assert_eq!(v["sampleRate"], 48000);
        assert_eq!(v["bufferFrames"], 128);
        // f32 8.4 is not exactly representable; compare with tolerance.
        assert!((v["estimatedLatencyMs"].as_f64().unwrap() - 8.4).abs() < 1e-4);
    }

    #[test]
    fn sanitize_clamps_top_level() {
        let raw = RawPatch {
            input_gain: Some(99.0),
            mix: Some(-3.0),
            slots: vec![],
        };
        let s = sanitize_patch(&raw);
        assert_eq!(s.input_gain, 3.0);
        assert_eq!(s.mix, 0.0);
    }

    #[test]
    fn sanitize_defaults_non_finite_to_neutral() {
        let raw = RawPatch {
            input_gain: Some(f64::NAN),
            mix: Some(f64::INFINITY),
            slots: vec![],
        };
        let s = sanitize_patch(&raw);
        assert_eq!(s.input_gain, 1.0); // NaN -> default 1.0, not min 0.0
        assert_eq!(s.mix, 1.0);
    }

    #[test]
    fn sanitize_drops_disabled_and_unknown() {
        let raw = RawPatch {
            input_gain: None,
            mix: None,
            slots: vec![
                slot("drive", true, &[("drive", 0.5)]),
                slot("filter", false, &[]), // disabled -> dropped
                slot("bogus", true, &[]),   // unknown -> dropped
                slot("reverb", true, &[]),
            ],
        };
        let s = sanitize_patch(&raw);
        assert_eq!(s.effects.len(), 2);
        assert!(matches!(s.effects[0], EffectParams::Drive { .. }));
        assert!(matches!(s.effects[1], EffectParams::Reverb { .. }));
    }

    #[test]
    fn sanitize_clamps_effect_params_and_rounds_indices() {
        let raw = RawPatch {
            input_gain: None,
            mix: None,
            slots: vec![
                slot("drive", true, &[("drive", 5.0), ("character", 2.6)]),
                slot("filter", true, &[("freq", 1.0), ("type", 9.0)]),
                slot("delay", true, &[("feedback", 2.0)]),
            ],
        };
        let s = sanitize_patch(&raw);
        match s.effects[0] {
            EffectParams::Drive {
                drive, character, ..
            } => {
                assert_eq!(drive, 1.0); // clamped from 5.0
                assert_eq!(character, 3); // 2.6 rounds to 3
            }
            _ => panic!(),
        }
        match s.effects[1] {
            EffectParams::Filter { freq, ftype, .. } => {
                assert_eq!(freq, 30.0); // clamped up to min
                assert_eq!(ftype, 3); // clamped to max index
            }
            _ => panic!(),
        }
        match s.effects[2] {
            EffectParams::Delay { feedback, .. } => assert_eq!(feedback, 0.95),
            _ => panic!(),
        }
    }

    #[test]
    fn sanitize_preserves_chain_order() {
        let raw = RawPatch {
            input_gain: None,
            mix: None,
            slots: vec![
                slot("reverb", true, &[]),
                slot("drive", true, &[]),
                slot("delay", true, &[]),
            ],
        };
        let s = sanitize_patch(&raw);
        assert!(matches!(s.effects[0], EffectParams::Reverb { .. }));
        assert!(matches!(s.effects[1], EffectParams::Drive { .. }));
        assert!(matches!(s.effects[2], EffectParams::Delay { .. }));
    }

    #[test]
    fn missing_params_use_defaults() {
        let raw = RawPatch {
            input_gain: None,
            mix: None,
            slots: vec![slot("comp", true, &[])],
        };
        let s = sanitize_patch(&raw);
        match s.effects[0] {
            EffectParams::Comp { amount, mix, .. } => {
                assert_eq!(amount, 0.4);
                assert_eq!(mix, 1.0);
            }
            _ => panic!(),
        }
    }
}
