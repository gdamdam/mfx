//! Always-last brickwall safety limiter.
//!
//! Mirrors the browser engine's output `DynamicsCompressorNode`
//! (threshold −1 dBFS, ratio ~20, attack 2 ms, release 120 ms) as a
//! feed-forward, stereo-linked peak limiter, then hard-clamps to ±1.0 as an
//! absolute final safety so no transient (before the envelope reacts) can leave
//! the box above full scale. This is not a musical, user-facing effect — it is
//! the guard that makes "changing bypass does not blast output" true.

use super::flush;

/// −1 dBFS as a linear amplitude.
const THRESHOLD: f32 = 0.891_250_9; // 10^(-1/20)
const ATTACK_SEC: f32 = 0.002;
const RELEASE_SEC: f32 = 0.12;

#[derive(Debug, Clone)]
pub struct Limiter {
    attack_coeff: f32,
    release_coeff: f32,
    gain: f32,
}

impl Limiter {
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48000.0
        };
        Limiter {
            attack_coeff: (-1.0 / (ATTACK_SEC * sr)).exp(),
            release_coeff: (-1.0 / (RELEASE_SEC * sr)).exp(),
            gain: 1.0,
        }
    }

    pub fn reset(&mut self) {
        self.gain = 1.0;
    }

    /// Current gain reduction, 0.0 (none) .. 1.0 (full).
    pub fn reduction(&self) -> f32 {
        (1.0 - self.gain).clamp(0.0, 1.0)
    }

    /// Process one stereo frame. Returns the limited, hard-clamped pair.
    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let l = flush(l);
        let r = flush(r);
        let detect = l.abs().max(r.abs());
        let target = if detect > THRESHOLD {
            THRESHOLD / detect
        } else {
            1.0
        };
        // Fast attack when clamping down, slow release when recovering.
        let coeff = if target < self.gain {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        self.gain = target + (self.gain - target) * coeff;
        // Final hard clamp: guarantees no over-full-scale sample ever escapes,
        // even on the first transient before the envelope catches up.
        (
            (l * self.gain).clamp(-1.0, 1.0),
            (r * self.gain).clamp(-1.0, 1.0),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_stays_silence() {
        let mut lim = Limiter::new(48000.0);
        for _ in 0..1000 {
            assert_eq!(lim.process(0.0, 0.0), (0.0, 0.0));
        }
        assert_eq!(lim.reduction(), 0.0);
    }

    #[test]
    fn steady_full_scale_settles_at_threshold() {
        let mut lim = Limiter::new(48000.0);
        let mut out = (0.0, 0.0);
        for _ in 0..4000 {
            out = lim.process(1.0, 1.0);
        }
        // After the attack settles, output tracks the threshold.
        assert!(
            (out.0 - THRESHOLD).abs() < 1e-2,
            "left settled at {}",
            out.0
        );
        assert!(lim.reduction() > 0.0);
    }

    #[test]
    fn output_never_exceeds_full_scale() {
        let mut lim = Limiter::new(48000.0);
        // Hostile input well over full scale, including the very first sample.
        for i in 0..2000 {
            let x = if i % 2 == 0 { 5.0 } else { -5.0 };
            let (l, r) = lim.process(x, x * 0.5);
            assert!(l.abs() <= 1.0 + 1e-6, "left {} exceeded", l);
            assert!(r.abs() <= 1.0 + 1e-6, "right {} exceeded", r);
        }
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut lim = Limiter::new(44100.0);
            let mut acc = 0.0f32;
            for i in 0..500 {
                let x = ((i as f32) * 0.01).sin() * 1.5;
                let (l, _) = lim.process(x, x);
                acc += l;
            }
            acc
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn scrubs_non_finite_input() {
        let mut lim = Limiter::new(48000.0);
        let (l, r) = lim.process(f32::NAN, f32::INFINITY);
        assert!(l.is_finite() && r.is_finite());
    }
}
