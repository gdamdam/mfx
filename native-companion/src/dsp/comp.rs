//! Feed-forward, stereo-linked peak compressor with a soft knee, makeup, and
//! parallel mix.
//!
//! MVP is the peak detector path (the browser also offers RMS + lookahead — see
//! the design doc's deferred notes). Allocation-free, finite-guarded.

use super::flush;

const KNEE_DB: f32 = 6.0;

pub struct Comp {
    attack_coeff: f32,
    release_coeff: f32,
    th_db: f32,
    slope: f32,
    makeup_db: f32,
    mix: f32,
    env: f32,
}

impl Comp {
    pub fn new(sr: f32) -> Self {
        let mut c = Comp {
            attack_coeff: 0.0,
            release_coeff: 0.0,
            th_db: 0.0,
            slope: 0.0,
            makeup_db: 0.0,
            mix: 1.0,
            env: 0.0,
        };
        c.set_params(0.4, 0.2, 0.45, 0.5, 1.0, sr);
        c
    }

    pub fn set_params(
        &mut self,
        amount: f32,
        attack: f32,
        release: f32,
        makeup: f32,
        mix: f32,
        sr: f32,
    ) {
        let amount = amount.clamp(0.0, 1.0);
        let attack_sec = 0.001 + attack.clamp(0.0, 1.0) * 0.099;
        let release_sec = 0.02 + release.clamp(0.0, 1.0) * 0.78;
        self.attack_coeff = (-1.0 / (attack_sec * sr)).exp();
        self.release_coeff = (-1.0 / (release_sec * sr)).exp();
        self.th_db = -6.0 - 34.0 * amount;
        let ratio = 1.5 + 10.5 * amount;
        self.slope = 1.0 - 1.0 / ratio;
        self.makeup_db = makeup.clamp(0.0, 1.0) * 18.0;
        self.mix = mix.clamp(0.0, 1.0);
    }

    pub fn reset(&mut self) {
        self.env = 0.0;
    }

    #[inline]
    fn reduction_db(&self, over: f32) -> f32 {
        let half = KNEE_DB * 0.5;
        if over <= -half {
            0.0
        } else if over >= half {
            self.slope * over
        } else {
            let x = over + half;
            self.slope * x * x / (2.0 * KNEE_DB)
        }
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let detect = l.abs().max(r.abs());
        let coeff = if detect > self.env {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        self.env = flush(detect + (self.env - detect) * coeff);

        let level_db = 20.0 * (self.env + 1e-9).log10();
        let red_db = self.reduction_db(level_db - self.th_db);
        let gain = 10f32.powf((self.makeup_db - red_db) / 20.0);

        let wet_l = l * gain;
        let wet_r = r * gain;
        (
            flush(l * (1.0 - self.mix) + wet_l * self.mix),
            flush(r * (1.0 - self.mix) + wet_r * self.mix),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peak_out(c: &mut Comp, amp: f32, n: usize) -> f32 {
        let mut peak = 0.0f32;
        for i in 0..n {
            let x = ((i as f32) * 0.05).sin() * amp;
            let (l, _) = c.process(x, x);
            if i > n / 2 {
                peak = peak.max(l.abs());
            }
        }
        peak
    }

    #[test]
    fn silence_stays_silence() {
        let mut c = Comp::new(48000.0);
        for _ in 0..512 {
            let (l, r) = c.process(0.0, 0.0);
            assert!(l.abs() < 1e-6 && r.abs() < 1e-6);
        }
    }

    #[test]
    fn compresses_loud_signal() {
        // Strong compression, no makeup: a hot signal should come out quieter.
        let mut c = Comp::new(48000.0);
        c.set_params(1.0, 0.1, 0.3, 0.0, 1.0, 48000.0);
        let out = peak_out(&mut c, 0.9, 4000);
        assert!(out < 0.9, "compressed peak {out} not below input 0.9");
    }

    #[test]
    fn makeup_raises_quiet_signal() {
        let mut flat = Comp::new(48000.0);
        flat.set_params(0.0, 0.5, 0.5, 0.0, 1.0, 48000.0);
        let mut lifted = Comp::new(48000.0);
        lifted.set_params(0.0, 0.5, 0.5, 1.0, 1.0, 48000.0);
        let a = peak_out(&mut flat, 0.05, 2000);
        let b = peak_out(&mut lifted, 0.05, 2000);
        assert!(b > a * 2.0, "makeup {b} not above flat {a}");
    }

    #[test]
    fn full_scale_stays_finite() {
        let mut c = Comp::new(48000.0);
        c.set_params(1.0, 0.0, 0.0, 1.0, 1.0, 48000.0);
        for i in 0..4000 {
            let x = if i % 2 == 0 { 1.0 } else { -1.0 };
            let (l, r) = c.process(x, x);
            assert!(l.is_finite() && r.is_finite());
        }
    }

    #[test]
    fn param_extremes_are_finite() {
        for &(am, at, re, mk, mx) in &[(0.0, 0.0, 0.0, 0.0, 0.0), (1.0, 1.0, 1.0, 1.0, 1.0)] {
            let mut c = Comp::new(44100.0);
            c.set_params(am, at, re, mk, mx, 44100.0);
            let (l, _) = c.process(0.7, -0.7);
            assert!(l.is_finite());
        }
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut c = Comp::new(48000.0);
            c.set_params(0.6, 0.3, 0.4, 0.5, 1.0, 48000.0);
            let mut acc = 0.0f32;
            for i in 0..500 {
                let x = ((i as f32) * 0.05).sin() * 0.6;
                acc += c.process(x, x).0;
            }
            acc
        };
        assert_eq!(run(), run());
    }
}
