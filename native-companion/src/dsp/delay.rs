//! Stereo delay with a tone-shaped feedback path and click-free time changes.
//!
//! MVP is the plain stereo mode (the browser also has ping-pong / reverse / sync
//! — deferred). Delay lines are pre-allocated for the maximum time; the time
//! control is smoothed so sweeps don't zipper. Allocation-free, finite-guarded.

use super::{flush, DelayLine, OnePole, Smoother};

const MAX_TIME_SEC: f32 = 1.5;

pub struct Delay {
    line: [DelayLine; 2],
    tone_lp: [OnePole; 2],
    time_samples: Smoother,
    feedback: f32,
    mix: f32,
    primed: bool,
}

impl Delay {
    pub fn new(sr: f32) -> Self {
        let max = (sr * MAX_TIME_SEC) as usize + 4;
        Delay {
            line: [DelayLine::new(max), DelayLine::new(max)],
            tone_lp: [OnePole::new(), OnePole::new()],
            time_samples: Smoother::new(sr, 0.05, 0.3 * sr),
            feedback: 0.4,
            mix: 0.35,
            primed: false,
        }
    }

    pub fn set_params(&mut self, time: f32, feedback: f32, mix: f32, tone: f32, sr: f32) {
        let time = time.clamp(0.02, MAX_TIME_SEC);
        let target = time * sr;
        if self.primed {
            // Glide subsequent time changes to avoid zipper noise.
            self.time_samples.set_target(target);
        } else {
            // Snap to the first requested time so the initial patch doesn't
            // slide in from the construction default.
            self.time_samples.reset(target);
            self.primed = true;
        }
        self.feedback = feedback.clamp(0.0, 0.95);
        self.mix = mix.clamp(0.0, 1.0);
        // tone: dark (low cutoff) -> bright (high cutoff) in the feedback path.
        let cutoff = 500.0 + tone.clamp(0.0, 1.0) * 15000.0;
        for lp in &mut self.tone_lp {
            lp.set_cutoff(cutoff, sr);
        }
    }

    pub fn reset(&mut self) {
        for l in &mut self.line {
            l.reset();
        }
        for lp in &mut self.tone_lp {
            lp.reset();
        }
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let t = self.time_samples.tick();
        (self.channel(0, l, t), self.channel(1, r, t))
    }

    #[inline]
    fn channel(&mut self, i: usize, x: f32, t: f32) -> f32 {
        let delayed = self.line[i].read(t);
        let toned = self.tone_lp[i].lp(delayed);
        self.line[i].write(x + toned * self.feedback);
        flush(x * (1.0 - self.mix) + delayed * self.mix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_stays_silence() {
        let mut d = Delay::new(48000.0);
        d.set_params(0.1, 0.5, 0.5, 0.5, 48000.0);
        for _ in 0..512 {
            let (l, r) = d.process(0.0, 0.0);
            assert!(l.abs() < 1e-6 && r.abs() < 1e-6);
        }
    }

    #[test]
    fn impulse_echoes_after_delay_time() {
        let sr = 48000.0;
        let mut d = Delay::new(sr);
        // 100 % wet, no feedback, 20 ms delay = 960 samples (the min time).
        d.set_params(0.02, 0.0, 1.0, 1.0, sr);
        let expected = 960i64;
        let mut echo_at = None;
        d.process(1.0, 1.0); // impulse
        for n in 1..4000 {
            let (l, _) = d.process(0.0, 0.0);
            if l.abs() > 0.3 {
                echo_at = Some(n);
                break;
            }
        }
        let n = echo_at.expect("no echo observed");
        assert!(
            (n as i64 - expected).abs() < 20,
            "echo at {n}, expected ~{expected}"
        );
    }

    #[test]
    fn feedback_decays_and_stays_finite() {
        let mut d = Delay::new(48000.0);
        d.set_params(0.02, 0.95, 1.0, 0.5, 48000.0);
        d.process(1.0, 1.0);
        for _ in 0..200_000 {
            let (l, r) = d.process(0.0, 0.0);
            assert!(l.is_finite() && r.is_finite());
            assert!(l.abs() < 4.0, "feedback runaway {l}");
        }
    }

    #[test]
    fn param_extremes_are_finite() {
        for &(t, fb, mx, tn) in &[(0.02, 0.0, 0.0, 0.0), (1.5, 0.95, 1.0, 1.0)] {
            let mut d = Delay::new(44100.0);
            d.set_params(t, fb, mx, tn, 44100.0);
            for _ in 0..1000 {
                let (l, _) = d.process(0.5, -0.5);
                assert!(l.is_finite());
            }
        }
    }

    #[test]
    fn deterministic() {
        let run = || {
            let mut d = Delay::new(48000.0);
            d.set_params(0.25, 0.5, 0.4, 0.6, 48000.0);
            let mut acc = 0.0f32;
            for i in 0..2000 {
                let x = if i == 0 { 1.0 } else { 0.0 };
                acc += d.process(x, x).0;
            }
            acc
        };
        assert_eq!(run(), run());
    }
}
