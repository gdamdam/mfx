//! Overdrive with soft / hard / tube / tape / germ / silicon / fold voices.
//!
//! Ported from the browser worklet's drive core (see the design doc). MVP runs
//! at 1× (no oversampling — acceptable for a drive at 48 kHz); the tone control
//! and per-voice normalization match the browser. Asymmetric voices are
//! DC-blocked. Allocation-free; every output is finite-guarded.

use super::{flush, DcBlocker, OnePole};

/// Voice count (character index 0..=6).
const VOICES: u8 = 6;

pub struct Drive {
    drive: f32,
    tone: f32,
    level: f32,
    character: u8,
    tone_lp: [OnePole; 2],
    dc: [DcBlocker; 2],
}

impl Drive {
    pub fn new(sr: f32) -> Self {
        Drive {
            drive: 0.4,
            tone: 0.55,
            level: 0.85,
            character: 0,
            tone_lp: [OnePole::new(), OnePole::new()],
            dc: [DcBlocker::new(sr), DcBlocker::new(sr)],
        }
    }

    pub fn set_params(&mut self, drive: f32, tone: f32, level: f32, character: u8, sr: f32) {
        self.drive = drive.clamp(0.0, 1.0);
        self.tone = tone.clamp(0.0, 1.0);
        self.level = level.clamp(0.0, 1.0);
        self.character = character.min(VOICES);
        let cutoff = 400.0 + self.tone * 12000.0;
        for lp in &mut self.tone_lp {
            lp.set_cutoff(cutoff, sr);
        }
    }

    pub fn reset(&mut self) {
        for lp in &mut self.tone_lp {
            lp.reset();
        }
        for dc in &mut self.dc {
            dc.reset();
        }
    }

    /// Memoryless waveshaper for the current voice.
    fn shape(&self, u: f32) -> f32 {
        match self.character {
            0 => u.tanh(),                            // Soft
            1 => u.clamp(-1.0, 1.0),                  // Hard
            2 => (u + 0.22).tanh() - 0.22_f32.tanh(), // Tube
            3 => u / (1.0 + u.abs()),                 // Tape
            4 => {
                // Germanium: asymmetric bias.
                let a = if u >= 0.0 { 0.8 } else { 1.3 };
                (u * a + 0.25).tanh() - 0.25_f32.tanh()
            }
            5 => {
                // Silicon
                let v = 1.5 * u;
                v / (1.0 + v * v).sqrt()
            }
            _ => fold(u), // Fold
        }
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        (self.channel(0, l), self.channel(1, r))
    }

    #[inline]
    fn channel(&mut self, i: usize, x: f32) -> f32 {
        let g = 1.0 + self.drive * 39.0;
        // Small-signal normalization so louder drive doesn't just get louder.
        let k = 0.5_f32.tanh() / (0.5 * g).tanh();
        let mut y = self.shape(x * g) * k;
        if self.character == 2 || self.character == 4 {
            y = self.dc[i].process(y);
        }
        let lp = self.tone_lp[i].lp(y);
        let toned = lp * (1.0 - self.tone) + y * self.tone;
        flush(toned * self.level)
    }
}

/// Triangle wave-folder, bounded by an iteration cap plus a final clamp so a
/// hostile input can never loop unbounded or leave the [-1, 1] range.
fn fold(x: f32) -> f32 {
    let mut v = x;
    for _ in 0..8 {
        if v > 1.0 {
            v = 2.0 - v;
        } else if v < -1.0 {
            v = -2.0 - v;
        } else {
            break;
        }
    }
    v.clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive_with(character: u8) -> Drive {
        let mut d = Drive::new(48000.0);
        d.set_params(0.6, 0.5, 0.8, character, 48000.0);
        d
    }

    #[test]
    fn silence_stays_silence_for_all_voices() {
        for v in 0..=VOICES {
            let mut d = drive_with(v);
            for _ in 0..256 {
                let (l, r) = d.process(0.0, 0.0);
                assert!(l.abs() < 1e-6 && r.abs() < 1e-6, "voice {v} leaked");
            }
        }
    }

    #[test]
    fn full_scale_stays_finite_and_bounded_for_all_voices() {
        for v in 0..=VOICES {
            let mut d = drive_with(v);
            for i in 0..1000 {
                let x = if i % 2 == 0 { 1.0 } else { -1.0 };
                let (l, r) = d.process(x, x);
                assert!(l.is_finite() && r.is_finite(), "voice {v} non-finite");
                // level<=1 and shapers are bounded ~1, so output stays sane.
                assert!(l.abs() <= 2.0, "voice {v} runaway {l}");
            }
        }
    }

    #[test]
    fn param_extremes_are_finite() {
        for &(dr, tn, lv) in &[(0.0, 0.0, 0.0), (1.0, 1.0, 1.0), (1.0, 0.0, 1.0)] {
            for v in 0..=VOICES {
                let mut d = Drive::new(44100.0);
                d.set_params(dr, tn, lv, v, 44100.0);
                let (l, _) = d.process(0.9, -0.9);
                assert!(l.is_finite());
            }
        }
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut d = drive_with(2);
            let mut acc = 0.0f32;
            for i in 0..500 {
                let x = ((i as f32) * 0.03).sin();
                acc += d.process(x, x).0;
            }
            acc
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn drive_adds_harmonics_raises_rms() {
        // A hard-driven sine should have more energy than a clean one at the
        // same input (soft clip lifts low-level, adds harmonics).
        let mut clean = Drive::new(48000.0);
        clean.set_params(0.0, 1.0, 1.0, 0, 48000.0);
        let mut dirty = Drive::new(48000.0);
        dirty.set_params(1.0, 1.0, 1.0, 0, 48000.0);
        let (mut ec, mut ed) = (0.0f32, 0.0f32);
        for i in 0..2000 {
            let x = ((i as f32) * 0.05).sin() * 0.2;
            ec += clean.process(x, x).0.powi(2);
            ed += dirty.process(x, x).0.powi(2);
        }
        assert!(ed > ec, "driven energy {ed} not above clean {ec}");
    }
}
