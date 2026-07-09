//! Trivial linear gain. Kept as its own core so the scaffold's module layout
//! matches the design and the gain path is unit-tested in isolation.

use super::flush;

/// Apply a linear gain to one sample, scrubbing non-finite/denormal results.
#[inline]
pub fn apply(sample: f32, gain: f32) -> f32 {
    flush(sample * gain)
}

/// Apply a linear gain to an interleaved-or-planar slice in place.
pub fn apply_buffer(buf: &mut [f32], gain: f32) {
    for s in buf.iter_mut() {
        *s = apply(*s, gain);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unity_gain_is_identity() {
        assert_eq!(apply(0.5, 1.0), 0.5);
        assert_eq!(apply(-0.3, 1.0), -0.3);
    }

    #[test]
    fn scales_linearly() {
        assert!((apply(0.5, 2.0) - 1.0).abs() < 1e-6);
        assert_eq!(apply(0.5, 0.0), 0.0);
    }

    #[test]
    fn scrubs_bad_input() {
        assert_eq!(apply(f32::NAN, 1.0), 0.0);
        assert_eq!(apply(1.0, f32::INFINITY), 0.0);
    }

    #[test]
    fn buffer_variant_matches_scalar() {
        let mut buf = [0.1, 0.2, -0.4];
        apply_buffer(&mut buf, 2.0);
        assert!((buf[0] - 0.2).abs() < 1e-6);
        assert!((buf[2] + 0.8).abs() < 1e-6);
    }
}
