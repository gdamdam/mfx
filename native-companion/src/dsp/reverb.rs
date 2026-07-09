//! Freeverb-style reverb: 8 damped parallel combs into 4 series allpasses per
//! channel, with a stereo spread.
//!
//! MVP maps `size`+`decay` to the comb feedback (tail length) and `damp` to the
//! in-loop damping; comb lengths are fixed at construction (the browser also
//! breathes lengths per mode — deferred). Buffers are allocated once; the
//! process path never allocates and is finite-guarded.

use super::flush;

// Classic Freeverb tunings, in samples at 44.1 kHz.
const COMB_TUNING: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING: [usize; 4] = [556, 441, 341, 225];
const STEREO_SPREAD: usize = 23;
const FIXED_GAIN: f32 = 0.015;

struct Comb {
    buf: Vec<f32>,
    idx: usize,
    filterstore: f32,
    feedback: f32,
    damp1: f32,
    damp2: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Comb {
            buf: vec![0.0; len.max(1)],
            idx: 0,
            filterstore: 0.0,
            feedback: 0.5,
            damp1: 0.5,
            damp2: 0.5,
        }
    }

    fn set(&mut self, feedback: f32, damp: f32) {
        self.feedback = feedback;
        self.damp1 = damp;
        self.damp2 = 1.0 - damp;
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let output = self.buf[self.idx];
        self.filterstore = flush(output * self.damp2 + self.filterstore * self.damp1);
        self.buf[self.idx] = flush(input + self.filterstore * self.feedback);
        self.idx += 1;
        if self.idx >= self.buf.len() {
            self.idx = 0;
        }
        output
    }

    fn reset(&mut self) {
        self.buf.iter_mut().for_each(|s| *s = 0.0);
        self.idx = 0;
        self.filterstore = 0.0;
    }
}

struct Allpass {
    buf: Vec<f32>,
    idx: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Allpass {
            buf: vec![0.0; len.max(1)],
            idx: 0,
        }
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let bufout = self.buf[self.idx];
        let output = -input + bufout;
        self.buf[self.idx] = flush(input + bufout * 0.5);
        self.idx += 1;
        if self.idx >= self.buf.len() {
            self.idx = 0;
        }
        output
    }

    fn reset(&mut self) {
        self.buf.iter_mut().for_each(|s| *s = 0.0);
        self.idx = 0;
    }
}

pub struct Reverb {
    combs_l: Vec<Comb>,
    combs_r: Vec<Comb>,
    allpass_l: Vec<Allpass>,
    allpass_r: Vec<Allpass>,
    mix: f32,
}

impl Reverb {
    pub fn new(sr: f32) -> Self {
        let scale = sr / 44100.0;
        let comb = |extra: usize| -> Vec<Comb> {
            COMB_TUNING
                .iter()
                .map(|&t| Comb::new(((t + extra) as f32 * scale) as usize))
                .collect()
        };
        let allpass = |extra: usize| -> Vec<Allpass> {
            ALLPASS_TUNING
                .iter()
                .map(|&t| Allpass::new(((t + extra) as f32 * scale) as usize))
                .collect()
        };
        let mut rv = Reverb {
            combs_l: comb(0),
            combs_r: comb(STEREO_SPREAD),
            allpass_l: allpass(0),
            allpass_r: allpass(STEREO_SPREAD),
            mix: 0.3,
        };
        rv.set_params(0.5, 0.5, 0.3, 0.5);
        rv
    }

    pub fn set_params(&mut self, size: f32, decay: f32, mix: f32, damp: f32) {
        let size = size.clamp(0.0, 1.0);
        let decay = decay.clamp(0.0, 1.0);
        // size + decay both lengthen the tail; capped below 1.0 for stability.
        let feedback = (0.7 + size * 0.20 + decay * 0.08).clamp(0.0, 0.98);
        let damping = damp.clamp(0.0, 1.0) * 0.4;
        for c in self.combs_l.iter_mut().chain(self.combs_r.iter_mut()) {
            c.set(feedback, damping);
        }
        self.mix = mix.clamp(0.0, 1.0);
    }

    pub fn reset(&mut self) {
        self.combs_l.iter_mut().for_each(Comb::reset);
        self.combs_r.iter_mut().for_each(Comb::reset);
        self.allpass_l.iter_mut().for_each(Allpass::reset);
        self.allpass_r.iter_mut().for_each(Allpass::reset);
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let input = (l + r) * FIXED_GAIN;

        let mut wet_l = 0.0;
        for c in &mut self.combs_l {
            wet_l += c.process(input);
        }
        for a in &mut self.allpass_l {
            wet_l = a.process(wet_l);
        }

        let mut wet_r = 0.0;
        for c in &mut self.combs_r {
            wet_r += c.process(input);
        }
        for a in &mut self.allpass_r {
            wet_r = a.process(wet_r);
        }

        (
            flush(l * (1.0 - self.mix) + wet_l * self.mix),
            flush(r * (1.0 - self.mix) + wet_r * self.mix),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_stays_silence() {
        let mut rv = Reverb::new(48000.0);
        for _ in 0..1000 {
            let (l, r) = rv.process(0.0, 0.0);
            assert!(l.abs() < 1e-6 && r.abs() < 1e-6);
        }
    }

    #[test]
    fn zero_mix_is_dry_passthrough() {
        let mut rv = Reverb::new(48000.0);
        rv.set_params(0.5, 0.5, 0.0, 0.5);
        for i in 0..512 {
            let x = ((i as f32) * 0.1).sin();
            let (l, _) = rv.process(x, x);
            assert!((l - x).abs() < 1e-6, "not dry at {i}");
        }
    }

    #[test]
    fn impulse_produces_decaying_tail() {
        let mut rv = Reverb::new(48000.0);
        rv.set_params(0.7, 0.7, 1.0, 0.5);
        rv.process(1.0, 1.0); // impulse
                              // Energy in an early window vs a much later window: tail must decay.
        let mut early = 0.0f32;
        let mut late = 0.0f32;
        for n in 0..96000 {
            let (l, _) = rv.process(0.0, 0.0);
            if n < 4800 {
                early += l * l;
            } else if n >= 91200 {
                late += l * l;
            }
        }
        assert!(early > 0.0, "no reverb energy");
        assert!(
            late < early,
            "tail did not decay: early {early} late {late}"
        );
    }

    #[test]
    fn high_settings_stay_finite_and_bounded() {
        // Worst case: max feedback, no damping, continuous full-scale square in.
        // The reverb is stable (feedback < 1), so it converges to a finite
        // steady state rather than diverging — peaks above 1.0 here are exactly
        // what the always-last master limiter exists to catch.
        let mut rv = Reverb::new(48000.0);
        rv.set_params(1.0, 1.0, 1.0, 0.0);
        for i in 0..200_000 {
            let x = if i % 2 == 0 { 1.0 } else { -1.0 };
            let (l, r) = rv.process(x, x);
            assert!(l.is_finite() && r.is_finite(), "non-finite at {i}");
            assert!(l.abs() < 30.0, "diverging: {l}");
        }
    }

    #[test]
    fn param_extremes_are_finite() {
        for &(sz, dc, mx, dp) in &[(0.0, 0.0, 0.0, 0.0), (1.0, 1.0, 1.0, 1.0)] {
            let mut rv = Reverb::new(44100.0);
            rv.set_params(sz, dc, mx, dp);
            for _ in 0..2000 {
                let (l, _) = rv.process(0.5, -0.5);
                assert!(l.is_finite());
            }
        }
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut rv = Reverb::new(48000.0);
            rv.set_params(0.6, 0.5, 0.4, 0.5);
            let mut acc = 0.0f32;
            for i in 0..2000 {
                let x = if i == 0 { 1.0 } else { 0.0 };
                acc += rv.process(x, x).0;
            }
            acc
        };
        assert_eq!(run(), run());
    }
}
