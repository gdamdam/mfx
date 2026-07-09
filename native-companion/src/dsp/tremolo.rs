//! Amplitude tremolo (classic mode) with a sine↔square shape control.
//!
//! MVP is the classic amplitude LFO (the browser also has harmonic / auto-pan —
//! deferred). Allocation-free, finite-guarded.

use super::{flush, TAU};

pub struct Tremolo {
    rate: f32,
    depth: f32,
    shape: f32,
    sr: f32,
    phase: f32,
}

impl Tremolo {
    pub fn new(sr: f32) -> Self {
        Tremolo {
            rate: 5.0,
            depth: 0.6,
            shape: 0.0,
            sr: sr.max(1.0),
            phase: 0.0,
        }
    }

    pub fn set_params(&mut self, rate: f32, depth: f32, shape: f32, sr: f32) {
        self.rate = rate.clamp(0.1, 16.0);
        self.depth = depth.clamp(0.0, 1.0);
        self.shape = shape.clamp(0.0, 1.0);
        self.sr = sr.max(1.0);
    }

    pub fn reset(&mut self) {
        self.phase = 0.0;
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let sine = (TAU * self.phase).sin();
        // Soft square via tanh, blended in by `shape`.
        let square = (sine * 6.0).tanh() / 6.0_f32.tanh();
        let lfo = sine * (1.0 - self.shape) + square * self.shape;
        // g in [1-depth, 1]; unity when the LFO peaks.
        let g = 1.0 - self.depth * (0.5 - 0.5 * lfo);

        self.phase += self.rate / self.sr;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        (flush(l * g), flush(r * g))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_stays_silence() {
        let mut t = Tremolo::new(48000.0);
        for _ in 0..512 {
            let (l, r) = t.process(0.0, 0.0);
            assert!(l.abs() < 1e-6 && r.abs() < 1e-6);
        }
    }

    #[test]
    fn zero_depth_is_passthrough() {
        let mut t = Tremolo::new(48000.0);
        t.set_params(5.0, 0.0, 0.0, 48000.0);
        for i in 0..512 {
            let x = ((i as f32) * 0.1).sin();
            let (l, _) = t.process(x, x);
            assert!((l - x).abs() < 1e-6, "not passthrough at {i}");
        }
    }

    #[test]
    fn modulates_amplitude() {
        let mut t = Tremolo::new(48000.0);
        t.set_params(8.0, 1.0, 0.0, 48000.0);
        let (mut min, mut max) = (f32::MAX, f32::MIN);
        for _ in 0..12000 {
            let (l, _) = t.process(1.0, 1.0); // DC input reveals the gain envelope
            min = min.min(l);
            max = max.max(l);
        }
        assert!(
            max - min > 0.5,
            "insufficient modulation depth {}",
            max - min
        );
    }

    #[test]
    fn param_extremes_are_finite() {
        for &(rt, dp, sh) in &[(0.1, 0.0, 0.0), (16.0, 1.0, 1.0)] {
            let mut t = Tremolo::new(44100.0);
            t.set_params(rt, dp, sh, 44100.0);
            for _ in 0..1000 {
                let (l, _) = t.process(0.8, -0.8);
                assert!(l.is_finite());
            }
        }
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut t = Tremolo::new(48000.0);
            t.set_params(6.0, 0.7, 0.3, 48000.0);
            let mut acc = 0.0f32;
            for i in 0..500 {
                let x = ((i as f32) * 0.05).sin();
                acc += t.process(x, x).0;
            }
            acc
        };
        assert_eq!(run(), run());
    }
}
