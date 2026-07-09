//! Audio device enumeration and latency estimation.
//!
//! Task A scope: enumerate the default host's input/output devices and provide
//! the config-derived latency estimate. The real-time duplex stream engine is
//! added in Task B and will live alongside these helpers.

use crate::protocol::DeviceInfo;
use cpal::traits::HostTrait;

/// Enumerate `(inputs, outputs)` on the default host. Never panics: on any host
/// error the corresponding list is empty (the companion still runs, it just
/// reports no devices — which the browser surfaces honestly).
pub fn list_devices() -> (Vec<DeviceInfo>, Vec<DeviceInfo>) {
    let host = cpal::default_host();
    (
        collect(host.input_devices()),
        collect(host.output_devices()),
    )
}

/// cpal 0.18 exposes the device name via `Display` (`to_string()`); we key the
/// wire `id` on that same string, which the browser echoes back in `setAudio`
/// and Task B matches against when building the stream.
fn collect<I>(devices: Result<I, cpal::Error>) -> Vec<DeviceInfo>
where
    I: Iterator<Item = cpal::Device>,
{
    let Ok(devices) = devices else {
        return Vec::new();
    };
    devices
        .map(|d| {
            let name = d.to_string();
            DeviceInfo {
                id: name.clone(),
                name,
            }
        })
        .collect()
}

/// Config-derived output-latency estimate in milliseconds: input buffer + output
/// buffer worth of frames over the sample rate. Labeled as an *estimate* in the
/// protocol; the ground-truth figure comes from the physical-loopback QA step.
pub fn estimate_latency_ms(sample_rate: u32, buffer_frames: u32) -> f32 {
    if sample_rate == 0 {
        return 0.0;
    }
    // Duplex path ≈ one input buffer + one output buffer.
    2.0 * buffer_frames as f32 / sample_rate as f32 * 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latency_estimate_is_two_buffers() {
        // 128 frames @ 48k -> ~5.33 ms round path.
        let ms = estimate_latency_ms(48000, 128);
        assert!((ms - 5.333).abs() < 0.01, "got {ms}");
    }

    #[test]
    fn latency_estimate_guards_zero_sample_rate() {
        assert_eq!(estimate_latency_ms(0, 128), 0.0);
    }

    #[test]
    fn enumeration_never_panics() {
        // We can't assert specific devices in CI, but this must not panic and
        // must return owned vecs (possibly empty in a headless environment).
        let (inputs, outputs) = list_devices();
        let _ = inputs.len();
        let _ = outputs.len();
    }
}
