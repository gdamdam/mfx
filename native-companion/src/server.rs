//! WebSocket control-plane session handling.
//!
//! `run_session` is generic over any async stream so it can be driven by a real
//! `TcpStream` in `main` and by an in-memory duplex pipe in tests (binding a
//! real port isn't always available in CI/sandboxes).
//!
//! Split of concerns: [`Session`] is pure, socket-free protocol state (clamps,
//! negotiation, config building) and is unit-tested directly. `run_session` owns
//! the `!Send`-stream-holding [`AudioController`] and performs the audio
//! side-effects (device open runs on `spawn_blocking` so it never stalls the
//! reactor), then ships the messages the session produces.

use crate::audio;
use crate::engine::{AudioController, ProcessConfig};
use crate::protocol::{self, ClientMessage, RawPatch, SanitizedPatch, ServerMessage};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::Message;

/// Pure per-connection control state.
pub struct Session {
    protocol: u32,
    sample_rate: u32,
    buffer_frames: u32,
    bypass: bool,
    patch: SanitizedPatch,
}

impl Default for Session {
    fn default() -> Self {
        Session::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Session {
            protocol: protocol::PROTOCOL_VERSION,
            sample_rate: 48000,
            buffer_frames: 128,
            bypass: false,
            patch: SanitizedPatch::default(),
        }
    }

    /// Negotiate the wire protocol down to the lower of the two versions.
    pub fn welcome(&mut self, client_protocol: u32) -> ServerMessage {
        self.protocol = client_protocol.clamp(1, protocol::PROTOCOL_VERSION);
        ServerMessage::Welcome {
            protocol: self.protocol,
            version: protocol::COMPANION_VERSION.into(),
            capabilities: protocol::capabilities(),
        }
    }

    pub fn set_audio_params(&mut self, sample_rate: Option<u32>, buffer_frames: Option<u32>) {
        if let Some(sr) = sample_rate {
            self.sample_rate = sr.clamp(8000, 192_000);
        }
        if let Some(bf) = buffer_frames {
            self.buffer_frames = bf.clamp(16, 8192);
        }
    }

    pub fn set_patch(&mut self, raw: &RawPatch) {
        self.patch = protocol::sanitize_patch(raw);
    }

    pub fn set_bypass(&mut self, bypass: bool) {
        self.bypass = bypass;
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn buffer_frames(&self) -> u32 {
        self.buffer_frames
    }

    /// The current DSP config snapshot for the audio thread.
    pub fn config(&self) -> ProcessConfig {
        ProcessConfig::from_patch(&self.patch, self.bypass)
    }

    pub fn status(&self, running: bool, xruns: u64) -> ServerMessage {
        ServerMessage::Status {
            running,
            sample_rate: self.sample_rate,
            buffer_frames: self.buffer_frames,
            estimated_latency_ms: audio::estimate_latency_ms(self.sample_rate, self.buffer_frames),
            xruns,
            bypass: self.bypass,
        }
    }
}

/// Interpret one message, driving audio as needed, and return the frames to send.
async fn dispatch(
    msg: ClientMessage,
    session: &mut Session,
    audio: &mut Option<AudioController>,
) -> Vec<ServerMessage> {
    match msg {
        ClientMessage::Hello { protocol, .. } => vec![session.welcome(protocol)],
        ClientMessage::ListDevices => {
            let (inputs, outputs) = audio::list_devices();
            vec![ServerMessage::Devices { inputs, outputs }]
        }
        ClientMessage::SetAudio {
            input_device_id,
            output_device_id,
            sample_rate,
            buffer_frames,
        } => {
            session.set_audio_params(sample_rate, buffer_frames);
            // Drop any existing stream first so the device is free to reopen.
            *audio = None;
            let (sr, bf) = (session.sample_rate(), session.buffer_frames());
            let start = tokio::task::spawn_blocking(move || {
                AudioController::start(input_device_id, output_device_id, sr, bf)
            })
            .await;
            match start {
                Ok(Ok(mut controller)) => {
                    controller.set_config(session.config());
                    let xruns = controller.xruns();
                    *audio = Some(controller);
                    vec![session.status(true, xruns)]
                }
                Ok(Err(e)) => vec![
                    ServerMessage::Error {
                        message: format!("could not start audio: {e}"),
                    },
                    session.status(false, 0),
                ],
                Err(e) => vec![
                    ServerMessage::Error {
                        message: format!("audio startup task failed: {e}"),
                    },
                    session.status(false, 0),
                ],
            }
        }
        ClientMessage::SetPatch { patch } => {
            session.set_patch(&patch);
            push_config(session, audio);
            vec![status_now(session, audio)]
        }
        ClientMessage::SetBypass { bypass } => {
            session.set_bypass(bypass);
            push_config(session, audio);
            vec![status_now(session, audio)]
        }
        ClientMessage::Panic => {
            // Immediate silence: drop the stream. The browser re-sends setAudio
            // to resume. Simple and unambiguous for a panic.
            *audio = None;
            vec![status_now(session, audio)]
        }
    }
}

fn push_config(session: &Session, audio: &mut Option<AudioController>) {
    if let Some(controller) = audio.as_mut() {
        controller.set_config(session.config());
    }
}

fn status_now(session: &Session, audio: &Option<AudioController>) -> ServerMessage {
    let running = audio.is_some();
    let xruns = audio.as_ref().map(|a| a.xruns()).unwrap_or(0);
    session.status(running, xruns)
}

/// Accept a WebSocket handshake on `stream` and service the connection until it
/// closes. `peer` is a display label for logging only.
pub async fn run_session<S>(stream: S, peer: String)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[mfx-native] handshake failed from {peer}: {e}");
            return;
        }
    };
    eprintln!("[mfx-native] client connected: {peer}");
    let (mut sink, mut source) = ws.split();
    let mut session = Session::new();
    // One audio engine per connection; dropped (stops audio) on disconnect.
    let mut audio: Option<AudioController> = None;

    while let Some(frame) = source.next().await {
        let text = match frame {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) => break,
            Ok(_) => continue, // ping/pong/binary: tungstenite auto-pongs pings
            Err(e) => {
                eprintln!("[mfx-native] read error from {peer}: {e}");
                break;
            }
        };
        let Some(msg) = protocol::parse_client_message(&text) else {
            continue; // unknown/invalid frames dropped silently (forward-compat)
        };
        for out in dispatch(msg, &mut session, &mut audio).await {
            match serde_json::to_string(&out) {
                Ok(json) => {
                    if sink.send(Message::Text(json)).await.is_err() {
                        return;
                    }
                }
                Err(e) => eprintln!("[mfx-native] serialize error: {e}"),
            }
        }
    }
    eprintln!("[mfx-native] client disconnected: {peer}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn welcome_negotiates_protocol_down() {
        let mut s = Session::new();
        match s.welcome(9) {
            ServerMessage::Welcome { protocol, .. } => assert_eq!(protocol, 1),
            _ => panic!("expected welcome"),
        }
    }

    #[test]
    fn set_audio_params_clamp() {
        let mut s = Session::new();
        s.set_audio_params(Some(999_999), Some(1));
        assert_eq!(s.sample_rate(), 192_000);
        assert_eq!(s.buffer_frames(), 16);
    }

    #[test]
    fn bypass_reflected_in_config_and_status() {
        let mut s = Session::new();
        s.set_bypass(true);
        assert!(s.config().bypass);
        match s.status(false, 0) {
            ServerMessage::Status {
                bypass, running, ..
            } => {
                assert!(bypass);
                assert!(!running);
            }
            _ => panic!("expected status"),
        }
    }

    #[test]
    fn set_patch_populates_config_chain() {
        let mut s = Session::new();
        let raw: RawPatch = serde_json::from_str(
            r#"{"inputGain":1.5,"mix":0.5,"slots":[{"id":"drive","enabled":true,"params":{}}]}"#,
        )
        .unwrap();
        s.set_patch(&raw);
        let cfg = s.config();
        assert_eq!(cfg.input_gain, 1.5);
        assert_eq!(cfg.mix, 0.5);
        assert_eq!(cfg.chain_len, 1);
    }

    #[test]
    fn status_reports_estimated_latency() {
        let s = Session::new();
        match s.status(true, 3) {
            ServerMessage::Status {
                running,
                xruns,
                estimated_latency_ms,
                ..
            } => {
                assert!(running);
                assert_eq!(xruns, 3);
                assert!(estimated_latency_ms > 0.0);
            }
            _ => panic!("expected status"),
        }
    }
}
