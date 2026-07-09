//! Real-time audio engine: a cpal duplex stream driven by a lock-free config
//! snapshot, with an always-last safety limiter.
//!
//! Threading: `cpal::Stream` is `!Send` on macOS, so the streams are owned by a
//! dedicated OS thread ([`AudioController`] spawns it) — never a tokio task. The
//! control plane hands the latest [`ProcessConfig`] to the audio callback through
//! a wait-free `triple_buffer`; the input callback feeds the output callback
//! through an `rtrb` SPSC ring. The audio callback does **no allocation and no
//! locking** — only a wait-free buffer read, ring pops, and pure DSP.

use crate::dsp::{flush, limiter::Limiter, Smoother};
use crate::protocol::{EffectParams, SanitizedPatch};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Device, Host, StreamConfig};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};

/// Upper bound on chain length carried in a POD config snapshot. The browser
/// sends each effect at most once; extras beyond this are dropped.
pub const MAX_CHAIN: usize = 16;

/// A plain-old-data config snapshot handed to the audio thread. `Copy` with a
/// fixed-size chain array so it crosses the thread boundary through
/// `triple_buffer` with zero heap allocation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProcessConfig {
    /// Input trim, 0..3 linear.
    pub input_gain: f32,
    /// Master dry..wet, 0..1.
    pub mix: f32,
    /// Master output trim (not in the browser patch; reserved, default 1.0).
    pub output_gain: f32,
    /// Bypass the whole rack (dry passes straight through, still safety-limited).
    pub bypass: bool,
    /// Ordered effect chain; `chain[..chain_len]` are `Some`.
    pub chain: [Option<EffectParams>; MAX_CHAIN],
    pub chain_len: usize,
}

impl Default for ProcessConfig {
    fn default() -> Self {
        ProcessConfig {
            input_gain: 1.0,
            mix: 1.0,
            output_gain: 1.0,
            bypass: false,
            chain: [None; MAX_CHAIN],
            chain_len: 0,
        }
    }
}

impl ProcessConfig {
    /// Build a snapshot from a sanitized patch and the current bypass flag.
    pub fn from_patch(patch: &SanitizedPatch, bypass: bool) -> Self {
        let mut chain = [None; MAX_CHAIN];
        let mut chain_len = 0;
        for effect in patch.effects.iter().take(MAX_CHAIN) {
            chain[chain_len] = Some(*effect);
            chain_len += 1;
        }
        ProcessConfig {
            input_gain: patch.input_gain,
            mix: patch.mix,
            output_gain: 1.0,
            bypass,
            chain,
            chain_len,
        }
    }
}

/// The DSP graph state that lives on (and is only touched by) the audio thread.
/// Pure and allocation-free in `process`; unit-tested directly.
///
/// Task B wires input gain -> (dry) -> wet/dry mix -> output gain -> limiter.
/// The effect chain (`ProcessConfig::chain`) is applied between input gain and
/// the mix in Task C; until then `wet == dry`.
pub struct AudioProcessor {
    input_gain: Smoother,
    mix: Smoother,
    output_gain: Smoother,
    limiter: Limiter,
    bypass: bool,
}

impl AudioProcessor {
    pub fn new(sample_rate: f32) -> Self {
        AudioProcessor {
            input_gain: Smoother::new(sample_rate, 0.01, 1.0),
            mix: Smoother::new(sample_rate, 0.01, 1.0),
            output_gain: Smoother::new(sample_rate, 0.01, 1.0),
            limiter: Limiter::new(sample_rate),
            bypass: false,
        }
    }

    /// Adopt the latest config snapshot. Cheap: only retargets smoothers and
    /// flips the bypass flag (no allocation), safe to call every block.
    pub fn apply_config(&mut self, cfg: &ProcessConfig) {
        self.input_gain.set_target(cfg.input_gain);
        self.mix.set_target(cfg.mix);
        self.output_gain.set_target(cfg.output_gain);
        self.bypass = cfg.bypass;
        // Task C: retarget effect-chain params from cfg.chain here.
    }

    pub fn reset(&mut self) {
        self.input_gain.reset(1.0);
        self.mix.reset(1.0);
        self.output_gain.reset(1.0);
        self.limiter.reset();
    }

    pub fn reduction(&self) -> f32 {
        self.limiter.reduction()
    }

    /// Process one stereo frame. Allocation-free, branch-light, always ends in
    /// the safety limiter so no config change can blast the output.
    #[inline]
    pub fn process(&mut self, in_l: f32, in_r: f32) -> (f32, f32) {
        let ig = self.input_gain.tick();
        let dry_l = flush(in_l * ig);
        let dry_r = flush(in_r * ig);

        // Task C replaces this with the effect chain applied to (dry_l, dry_r).
        let (wet_l, wet_r) = (dry_l, dry_r);

        let m = self.mix.tick();
        let (mut out_l, mut out_r) = if self.bypass {
            (dry_l, dry_r)
        } else {
            (dry_l * (1.0 - m) + wet_l * m, dry_r * (1.0 - m) + wet_r * m)
        };

        let og = self.output_gain.tick();
        out_l *= og;
        out_r *= og;
        self.limiter.process(out_l, out_r)
    }
}

/// What the stream actually negotiated, reported back over the wire.
#[derive(Debug, Clone, Copy)]
pub struct StartedInfo {
    pub sample_rate: u32,
    pub buffer_frames: u32,
}

/// A `Send` handle to a running duplex audio engine. Owns the config producer
/// and the audio thread; dropping it stops audio and tears down the streams.
pub struct AudioController {
    cfg_in: triple_buffer::Input<ProcessConfig>,
    xruns: Arc<AtomicU64>,
    // Dropping this sender signals the audio thread to exit (and drop its
    // `!Send` streams on that same thread).
    _shutdown: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
    info: StartedInfo,
}

impl AudioController {
    /// Build and start a duplex stream. Blocks briefly while the audio thread
    /// opens the devices, then returns once the stream is live (or an error).
    pub fn start(
        input_id: Option<String>,
        output_id: Option<String>,
        sample_rate: u32,
        buffer_frames: u32,
    ) -> Result<AudioController, String> {
        let (cfg_in, cfg_out) = triple_buffer::triple_buffer(&ProcessConfig::default());
        let xruns = Arc::new(AtomicU64::new(0));
        let xruns_thread = xruns.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<StartedInfo, String>>();
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

        let thread = thread::Builder::new()
            .name("mfx-audio".into())
            .spawn(move || {
                match build_streams(
                    input_id,
                    output_id,
                    sample_rate,
                    buffer_frames,
                    cfg_out,
                    xruns_thread,
                ) {
                    Ok((info, _in_stream, _out_stream)) => {
                        let _ = ready_tx.send(Ok(info));
                        // Park until shutdown; the streams stay alive (and thus
                        // keep calling their callbacks) for as long as we hold
                        // them on this thread.
                        let _ = shutdown_rx.recv();
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| format!("could not spawn audio thread: {e}"))?;

        match ready_rx.recv() {
            Ok(Ok(info)) => Ok(AudioController {
                cfg_in,
                xruns,
                _shutdown: shutdown_tx,
                thread: Some(thread),
                info,
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(e) => Err(format!("audio thread exited during startup: {e}")),
        }
    }

    /// Publish a new config snapshot to the audio thread (wait-free).
    pub fn set_config(&mut self, cfg: ProcessConfig) {
        self.cfg_in.write(cfg);
    }

    pub fn xruns(&self) -> u64 {
        self.xruns.load(Ordering::Relaxed)
    }

    pub fn info(&self) -> StartedInfo {
        self.info
    }
}

impl Drop for AudioController {
    fn drop(&mut self) {
        // Dropping `_shutdown` wakes the audio thread; join so the streams are
        // fully torn down before we return.
        if let Some(handle) = self.thread.take() {
            drop(std::mem::replace(&mut self._shutdown, mpsc::channel().0));
            let _ = handle.join();
        }
    }
}

fn pick_device(host: &Host, id: Option<String>, input: bool) -> Result<Device, String> {
    if let Some(name) = id {
        let devices = if input {
            host.input_devices()
        } else {
            host.output_devices()
        };
        if let Ok(devices) = devices {
            for d in devices {
                if d.to_string() == name {
                    return Ok(d);
                }
            }
        }
    }
    let default = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    };
    default.ok_or_else(|| {
        format!(
            "no {} audio device available",
            if input { "input" } else { "output" }
        )
    })
}

/// Runs on the audio thread. Opens both devices, wires the ring + config
/// snapshot into the callbacks, and starts the streams. Returns the live streams
/// so the caller keeps them alive on this same thread.
fn build_streams(
    input_id: Option<String>,
    output_id: Option<String>,
    sample_rate: u32,
    buffer_frames: u32,
    mut cfg_out: triple_buffer::Output<ProcessConfig>,
    xruns: Arc<AtomicU64>,
) -> Result<(StartedInfo, cpal::Stream, cpal::Stream), String> {
    let host = cpal::default_host();
    let in_dev = pick_device(&host, input_id, true)?;
    let out_dev = pick_device(&host, output_id, false)?;

    let in_default = in_dev
        .default_input_config()
        .map_err(|e| format!("input device config: {e}"))?;
    let out_default = out_dev
        .default_output_config()
        .map_err(|e| format!("output device config: {e}"))?;

    let in_ch = in_default.channels().max(1) as usize;
    let out_ch = out_default.channels().max(1) as usize;

    let in_cfg = StreamConfig {
        channels: in_default.channels(),
        sample_rate,
        buffer_size: BufferSize::Fixed(buffer_frames),
    };
    let out_cfg = StreamConfig {
        channels: out_default.channels(),
        sample_rate,
        buffer_size: BufferSize::Fixed(buffer_frames),
    };

    // Stereo interleaved f32 ring, a few buffers deep, primed with one buffer of
    // silence so the output has a cushion before the input produces.
    let frames = (buffer_frames as usize).max(64);
    let (mut producer, mut consumer) = rtrb::RingBuffer::<f32>::new(frames * 8 * 2);
    for _ in 0..(frames * 2) {
        let _ = producer.push(0.0);
    }

    let xr_in = xruns.clone();
    let input_stream = in_dev
        .build_input_stream::<f32, _, _>(
            in_cfg,
            move |data: &[f32], _| {
                for frame in data.chunks(in_ch) {
                    let l = frame[0];
                    let r = if in_ch > 1 && frame.len() > 1 {
                        frame[1]
                    } else {
                        l
                    };
                    if producer.push(l).is_err() || producer.push(r).is_err() {
                        xr_in.fetch_add(1, Ordering::Relaxed);
                    }
                }
            },
            move |err| eprintln!("[mfx-native] input stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build input stream: {e}"))?;

    let mut processor = AudioProcessor::new(sample_rate as f32);
    let xr_out = xruns.clone();
    let output_stream = out_dev
        .build_output_stream::<f32, _, _>(
            out_cfg,
            move |data: &mut [f32], _| {
                processor.apply_config(cfg_out.read());
                for frame in data.chunks_mut(out_ch) {
                    let (l, r) = if consumer.slots() >= 2 {
                        // Safe: slots()>=2 guarantees two pops succeed.
                        (consumer.pop().unwrap_or(0.0), consumer.pop().unwrap_or(0.0))
                    } else {
                        xr_out.fetch_add(1, Ordering::Relaxed);
                        (0.0, 0.0)
                    };
                    let (out_l, out_r) = processor.process(l, r);
                    frame[0] = out_l;
                    if frame.len() > 1 {
                        frame[1] = out_r;
                    }
                    for extra in frame.iter_mut().skip(2) {
                        *extra = 0.0;
                    }
                }
            },
            move |err| eprintln!("[mfx-native] output stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build output stream: {e}"))?;

    input_stream
        .play()
        .map_err(|e| format!("play input: {e}"))?;
    output_stream
        .play()
        .map_err(|e| format!("play output: {e}"))?;

    Ok((
        StartedInfo {
            sample_rate,
            buffer_frames,
        },
        input_stream,
        output_stream,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settle(p: &mut AudioProcessor, l: f32, r: f32, n: usize) -> (f32, f32) {
        let mut out = (0.0, 0.0);
        for _ in 0..n {
            out = p.process(l, r);
        }
        out
    }

    #[test]
    fn passthrough_at_unity() {
        let mut p = AudioProcessor::new(48000.0);
        p.apply_config(&ProcessConfig::default());
        let (l, r) = settle(&mut p, 0.5, -0.4, 256);
        assert!((l - 0.5).abs() < 1e-3, "left {l}");
        assert!((r + 0.4).abs() < 1e-3, "right {r}");
    }

    #[test]
    fn input_gain_scales() {
        let mut p = AudioProcessor::new(48000.0);
        let cfg = ProcessConfig {
            input_gain: 2.0,
            ..ProcessConfig::default()
        };
        p.apply_config(&cfg);
        // 0.1 * 2.0 = 0.2, comfortably below the limiter threshold.
        let (l, _) = settle(&mut p, 0.1, 0.1, 4000);
        assert!((l - 0.2).abs() < 1e-3, "left {l}");
    }

    #[test]
    fn bypass_passes_dry_regardless_of_mix() {
        let mut p = AudioProcessor::new(48000.0);
        let cfg = ProcessConfig {
            mix: 0.0, // would mute wet in non-bypass, but bypass ignores mix
            bypass: true,
            ..ProcessConfig::default()
        };
        p.apply_config(&cfg);
        let (l, _) = settle(&mut p, 0.3, 0.3, 256);
        assert!((l - 0.3).abs() < 1e-3, "left {l}");
    }

    #[test]
    fn output_never_exceeds_full_scale() {
        let mut p = AudioProcessor::new(48000.0);
        let cfg = ProcessConfig {
            input_gain: 3.0,
            ..ProcessConfig::default()
        };
        p.apply_config(&cfg);
        for i in 0..4000 {
            let x = if i % 2 == 0 { 1.0 } else { -1.0 };
            let (l, r) = p.process(x, x);
            assert!(l.abs() <= 1.0 + 1e-6, "left {l}");
            assert!(r.abs() <= 1.0 + 1e-6, "right {r}");
        }
    }

    #[test]
    fn from_patch_maps_top_level_and_chain_len() {
        let patch = SanitizedPatch {
            input_gain: 1.5,
            mix: 0.7,
            effects: vec![
                EffectParams::Drive {
                    drive: 0.5,
                    tone: 0.5,
                    level: 0.8,
                    character: 0,
                },
                EffectParams::Reverb {
                    size: 0.5,
                    decay: 0.5,
                    mix: 0.3,
                    damp: 0.5,
                },
            ],
        };
        let cfg = ProcessConfig::from_patch(&patch, true);
        assert_eq!(cfg.input_gain, 1.5);
        assert_eq!(cfg.mix, 0.7);
        assert!(cfg.bypass);
        assert_eq!(cfg.chain_len, 2);
        assert!(cfg.chain[0].is_some());
        assert!(cfg.chain[2].is_none());
    }

    #[test]
    fn from_patch_caps_chain_at_max() {
        let effect = EffectParams::Drive {
            drive: 0.4,
            tone: 0.5,
            level: 0.8,
            character: 0,
        };
        let patch = SanitizedPatch {
            input_gain: 1.0,
            mix: 1.0,
            effects: vec![effect; MAX_CHAIN + 5],
        };
        let cfg = ProcessConfig::from_patch(&patch, false);
        assert_eq!(cfg.chain_len, MAX_CHAIN);
    }
}
