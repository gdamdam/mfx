//! Pure, allocation-free DSP cores.
//!
//! Every core is framework-free and does no allocation in its process path, so
//! it can run in the cpal real-time callback and be exercised directly in unit
//! tests. Cores guard inputs with `is_finite` and flush denormals, mirroring the
//! browser worklet's discipline.

pub mod comp;
pub mod delay;
pub mod drive;
pub mod filter;
pub mod gain;
pub mod limiter;
pub mod reverb;
pub mod tremolo;

/// 2π.
pub const TAU: f32 = std::f32::consts::TAU;

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

/// One-pole low-pass. `set_cutoff` is safe for any positive sample rate; the
/// coefficient is clamped so an out-of-range cutoff can't make it unstable.
#[derive(Debug, Clone, Default)]
pub struct OnePole {
    a: f32,
    z: f32,
}

impl OnePole {
    pub fn new() -> Self {
        OnePole::default()
    }

    pub fn set_cutoff(&mut self, cutoff_hz: f32, sr: f32) {
        let fc = cutoff_hz.clamp(1.0, sr * 0.49);
        self.a = (1.0 - (-TAU * fc / sr).exp()).clamp(0.0, 1.0);
    }

    #[inline]
    pub fn lp(&mut self, x: f32) -> f32 {
        self.z += self.a * (x - self.z);
        self.z = flush(self.z);
        self.z
    }

    /// High-pass = input minus the low-passed component.
    #[inline]
    pub fn hp(&mut self, x: f32) -> f32 {
        x - self.lp(x)
    }

    pub fn reset(&mut self) {
        self.z = 0.0;
    }
}

/// First-order DC blocker (~5 Hz corner). Removes the offset asymmetric
/// waveshapers introduce.
#[derive(Debug, Clone)]
pub struct DcBlocker {
    r: f32,
    x1: f32,
    y1: f32,
}

impl DcBlocker {
    pub fn new(sr: f32) -> Self {
        // R = 1 - (2π * fc / sr), fc ~ 5 Hz.
        let r = (1.0 - TAU * 5.0 / sr.max(1.0)).clamp(0.9, 0.99999);
        DcBlocker {
            r,
            x1: 0.0,
            y1: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = x - self.x1 + self.r * self.y1;
        self.x1 = x;
        self.y1 = flush(y);
        self.y1
    }

    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.y1 = 0.0;
    }
}

/// Fixed-capacity delay line with fractional (linearly interpolated) reads.
/// Allocated once; `read`/`write` never allocate.
#[derive(Debug, Clone)]
pub struct DelayLine {
    buf: Vec<f32>,
    write: usize,
}

impl DelayLine {
    /// `max_samples` is the largest delay that will be requested (rounded up).
    pub fn new(max_samples: usize) -> Self {
        DelayLine {
            buf: vec![0.0; max_samples.max(1)],
            write: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    /// Read `delay_samples` behind the write head (fractional, wrapping).
    #[inline]
    pub fn read(&self, delay_samples: f32) -> f32 {
        let len = self.buf.len();
        let d = delay_samples.clamp(1.0, (len - 1) as f32);
        let read_pos = self.write as f32 - d;
        let read_pos = if read_pos < 0.0 {
            read_pos + len as f32
        } else {
            read_pos
        };
        let i0 = read_pos.floor() as usize % len;
        let i1 = (i0 + 1) % len;
        let frac = read_pos - read_pos.floor();
        self.buf[i0] + (self.buf[i1] - self.buf[i0]) * frac
    }

    #[inline]
    pub fn write(&mut self, x: f32) {
        self.buf[self.write] = flush(x);
        self.write += 1;
        if self.write >= self.buf.len() {
            self.write = 0;
        }
    }

    pub fn reset(&mut self) {
        for s in self.buf.iter_mut() {
            *s = 0.0;
        }
        self.write = 0;
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

    #[test]
    fn delay_line_reads_back_written_sample() {
        let mut d = DelayLine::new(16);
        d.write(1.0);
        for _ in 0..4 {
            d.write(0.0);
        }
        // The 1.0 was written 5 samples ago.
        assert!((d.read(5.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn delay_line_clamps_out_of_range_delay() {
        let d = DelayLine::new(8);
        // Requesting a delay beyond capacity must not panic.
        let _ = d.read(1000.0);
        let _ = d.read(0.0);
    }

    #[test]
    fn onepole_lowpass_passes_dc_blocks_nyquist() {
        let mut lp = OnePole::new();
        lp.set_cutoff(1000.0, 48000.0);
        // DC settles to the input level.
        let mut y = 0.0;
        for _ in 0..2000 {
            y = lp.lp(1.0);
        }
        assert!((y - 1.0).abs() < 1e-2);
    }

    #[test]
    fn dc_blocker_removes_offset() {
        let mut dc = DcBlocker::new(48000.0);
        let mut y = 0.0;
        for _ in 0..48000 {
            y = dc.process(0.5); // constant offset
        }
        assert!(y.abs() < 1e-2, "residual dc {y}");
    }
}
