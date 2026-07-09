//! State-variable filter (Zavalishin TPT topology) with LP/BP/HP/NT outputs and
//! an input drive stage.
//!
//! MVP ships the SVF model only (the browser also has ladder/diode/comb — see the
//! design doc's deferred list). Per-channel state, allocation-free, finite-guarded.

use super::flush;
use std::f32::consts::PI;

/// Filter response type index.
const LP: u8 = 0;
const BP: u8 = 1;
const HP: u8 = 2;
const NT: u8 = 3;

pub struct Filter {
    ftype: u8,
    drive: f32,
    g: f32,
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    ic1: [f32; 2],
    ic2: [f32; 2],
}

impl Filter {
    pub fn new(sr: f32) -> Self {
        let mut f = Filter {
            ftype: LP,
            drive: 0.0,
            g: 0.0,
            k: 0.0,
            a1: 0.0,
            a2: 0.0,
            a3: 0.0,
            ic1: [0.0; 2],
            ic2: [0.0; 2],
        };
        f.set_params(1200.0, 0.2, LP, 0.0, sr);
        f
    }

    pub fn set_params(&mut self, freq: f32, reso: f32, ftype: u8, drive: f32, sr: f32) {
        self.ftype = ftype.min(NT);
        self.drive = drive.clamp(0.0, 1.0);
        let fc = freq.clamp(20.0, sr * 0.49);
        let reso = reso.clamp(0.0, 1.0);
        self.g = (PI * fc / sr).tan();
        // k: damping. reso 0 -> 1.0 (heavy damping), reso 1 -> 0.05 (resonant).
        self.k = 1.0 - 0.95 * reso;
        self.a1 = 1.0 / (1.0 + self.g * (self.g + self.k));
        self.a2 = self.g * self.a1;
        self.a3 = self.g * self.a2;
    }

    pub fn reset(&mut self) {
        self.ic1 = [0.0; 2];
        self.ic2 = [0.0; 2];
    }

    #[inline]
    fn drive_stage(&self, x: f32) -> f32 {
        if self.drive <= 0.0 {
            return x;
        }
        let d = self.drive;
        x + d * ((x * (1.0 + 7.0 * d)).tanh() - x)
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        (self.channel(0, l), self.channel(1, r))
    }

    #[inline]
    fn channel(&mut self, i: usize, x: f32) -> f32 {
        let x = self.drive_stage(x);
        let v3 = x - self.ic2[i];
        let v1 = self.a1 * self.ic1[i] + self.a2 * v3;
        let v2 = self.ic2[i] + self.a2 * self.ic1[i] + self.a3 * v3;
        self.ic1[i] = flush(2.0 * v1 - self.ic1[i]);
        self.ic2[i] = flush(2.0 * v2 - self.ic2[i]);
        let out = match self.ftype {
            LP => v2,
            BP => v1,
            HP => x - self.k * v1 - v2,
            _ => x - self.k * v1, // NT (notch) = LP + HP
        };
        flush(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn energy(ftype: u8, freq: f32, sig_hz: f32) -> f32 {
        let sr = 48000.0;
        let mut f = Filter::new(sr);
        f.set_params(freq, 0.3, ftype, 0.0, sr);
        let mut e = 0.0f32;
        for n in 0..4800 {
            let x = (super::super::TAU * sig_hz * n as f32 / sr).sin();
            let (l, _) = f.process(x, x);
            if n > 2400 {
                e += l * l;
            }
        }
        e
    }

    #[test]
    fn silence_stays_silence() {
        let mut f = Filter::new(48000.0);
        f.set_params(1000.0, 0.9, LP, 0.5, 48000.0);
        for _ in 0..512 {
            let (l, r) = f.process(0.0, 0.0);
            assert!(l.abs() < 1e-6 && r.abs() < 1e-6);
        }
    }

    #[test]
    fn lowpass_attenuates_highs_more_than_lows() {
        let low = energy(LP, 800.0, 100.0);
        let high = energy(LP, 800.0, 8000.0);
        assert!(low > high * 4.0, "lp low {low} vs high {high}");
    }

    #[test]
    fn highpass_attenuates_lows_more_than_highs() {
        let low = energy(HP, 800.0, 100.0);
        let high = energy(HP, 800.0, 8000.0);
        assert!(high > low * 4.0, "hp low {low} vs high {high}");
    }

    #[test]
    fn full_scale_and_high_reso_stay_finite() {
        let mut f = Filter::new(48000.0);
        f.set_params(5000.0, 1.0, BP, 1.0, 48000.0);
        for i in 0..4000 {
            let x = if i % 2 == 0 { 1.0 } else { -1.0 };
            let (l, r) = f.process(x, x);
            assert!(l.is_finite() && r.is_finite(), "non-finite at {i}");
        }
    }

    #[test]
    fn param_extremes_are_finite() {
        for &t in &[LP, BP, HP, NT] {
            for &(fq, rs, dr) in &[(20.0, 0.0, 0.0), (18000.0, 1.0, 1.0), (1000.0, 1.0, 0.0)] {
                let mut f = Filter::new(44100.0);
                f.set_params(fq, rs, t, dr, 44100.0);
                let (l, _) = f.process(0.8, -0.8);
                assert!(l.is_finite());
            }
        }
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut f = Filter::new(48000.0);
            f.set_params(2000.0, 0.7, BP, 0.3, 48000.0);
            let mut acc = 0.0f32;
            for i in 0..500 {
                let x = ((i as f32) * 0.04).sin();
                acc += f.process(x, x).0;
            }
            acc
        };
        assert_eq!(run(), run());
    }
}
