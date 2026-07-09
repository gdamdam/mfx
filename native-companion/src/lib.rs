//! mfx native companion — library surface.
//!
//! The audio engine, DSP cores, and wire protocol live here as a library so they
//! can be unit-tested directly and consumed by the thin `main.rs` binary. See
//! `docs/native-companion-design.md` for the design.

pub mod audio;
pub mod dsp;
pub mod protocol;
pub mod server;
