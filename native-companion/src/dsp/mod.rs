//! Pure, allocation-free DSP cores.
//!
//! Every core is framework-free and does no allocation in its process path, so
//! it can run in the cpal real-time callback and be exercised directly in unit
//! tests. Cores guard inputs with `is_finite` and flush denormals, mirroring the
//! browser worklet's discipline.

pub mod gain;
pub mod limiter;

/// Denormal flush: tiny magnitudes collapse to 0 to avoid CPU stalls in
/// feedback paths. Also scrubs NaN/Inf to 0 so a bad sample can't propagate.
#[inline]
pub fn flush(x: f32) -> f32 {
    if x.is_finite() && x.abs() > 1e-20 {
        x
    } else {
        0.0
    }
}

/// One-pole parameter smoother for click-free control changes. Used where
/// stepping a control per-block would click (input gain, wet/dry).
#[derive(Debug, Clone)]
pub struct Smoother {
    coeff: f32,
    value: f32,
    target: f32,
}

impl Smoother {
    /// `time_sec` is the ~63% settling time. `sr` is the sample rate in Hz.
    pub fn new(sr: f32, time_sec: f32, init: f32) -> Self {
        let coeff = if time_sec <= 0.0 {
            0.0
        } else {
            (-1.0 / (time_sec * sr)).exp()
        };
        Smoother {
            coeff,
            value: init,
            target: init,
        }
    }

    #[inline]
    pub fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    /// Jump immediately to `value` (e.g. on stream rebuild).
    pub fn reset(&mut self, value: f32) {
        self.value = value;
        self.target = value;
    }

    #[inline]
    pub fn tick(&mut self) -> f32 {
        self.value = self.target + (self.value - self.target) * self.coeff;
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flush_scrubs_denormals_and_nonfinite() {
        assert_eq!(flush(1e-30), 0.0);
        assert_eq!(flush(f32::NAN), 0.0);
        assert_eq!(flush(f32::INFINITY), 0.0);
        assert_eq!(flush(0.5), 0.5);
    }

    #[test]
    fn smoother_converges_to_target() {
        let mut s = Smoother::new(48000.0, 0.01, 0.0);
        s.set_target(1.0);
        for _ in 0..48000 {
            s.tick();
        }
        assert!((s.tick() - 1.0).abs() < 1e-3);
    }

    #[test]
    fn smoother_reset_jumps() {
        let mut s = Smoother::new(48000.0, 0.5, 0.0);
        s.reset(0.7);
        assert_eq!(s.tick(), 0.7);
    }
}
