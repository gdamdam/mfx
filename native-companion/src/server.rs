//! WebSocket control-plane session handling.
//!
//! `run_session` is generic over any async stream so it can be driven by a real
//! `TcpStream` in `main` and by an in-memory duplex pipe in tests (binding a
//! real port isn't always available in CI/sandboxes). `Session::handle` is
//! socket-free and unit-tested; the loop here just ships what it returns.

use crate::audio;
use crate::protocol::{self, ClientMessage, ServerMessage};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::Message;

/// Per-connection control state.
pub struct Session {
    protocol: u32,
    sample_rate: u32,
    buffer_frames: u32,
    bypass: bool,
    audio_started: bool,
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
            audio_started: false,
        }
    }

    fn status(&self) -> ServerMessage {
        ServerMessage::Status {
            running: self.audio_started,
            sample_rate: self.sample_rate,
            buffer_frames: self.buffer_frames,
            estimated_latency_ms: audio::estimate_latency_ms(self.sample_rate, self.buffer_frames),
            xruns: 0,
            bypass: self.bypass,
        }
    }

    /// Handle one parsed client message, returning the frames to send back.
    /// Deliberately socket-free so it can be unit-tested in isolation.
    pub fn handle(&mut self, msg: ClientMessage) -> Vec<ServerMessage> {
        match msg {
            ClientMessage::Hello { protocol, .. } => {
                // Negotiate down to the lower of the two protocol versions.
                self.protocol = protocol.clamp(1, protocol::PROTOCOL_VERSION);
                vec![ServerMessage::Welcome {
                    protocol: self.protocol,
                    version: protocol::COMPANION_VERSION.into(),
                    capabilities: protocol::capabilities(),
                }]
            }
            ClientMessage::ListDevices => {
                let (inputs, outputs) = audio::list_devices();
                vec![ServerMessage::Devices { inputs, outputs }]
            }
            ClientMessage::SetAudio {
                sample_rate,
                buffer_frames,
                ..
            } => {
                if let Some(sr) = sample_rate {
                    self.sample_rate = sr.clamp(8000, 192_000);
                }
                if let Some(bf) = buffer_frames {
                    self.buffer_frames = bf.clamp(16, 8192);
                }
                // Task A has no engine yet; report the negotiated config with
                // running=false. Task B flips this to a live stream.
                vec![self.status()]
            }
            ClientMessage::SetPatch { patch } => {
                // Sanitize now so bad input is rejected at the boundary even
                // before the engine exists to consume it.
                let _sanitized = protocol::sanitize_patch(&patch);
                vec![self.status()]
            }
            ClientMessage::SetBypass { bypass } => {
                self.bypass = bypass;
                vec![self.status()]
            }
            ClientMessage::Panic => vec![self.status()],
        }
    }
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
        for out in session.handle(msg) {
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
    fn hello_yields_welcome_with_negotiated_protocol() {
        let mut s = Session::new();
        let out = s.handle(ClientMessage::Hello {
            client: "mfx".into(),
            protocol: 9, // client claims a higher version
        });
        match &out[0] {
            ServerMessage::Welcome { protocol, .. } => assert_eq!(*protocol, 1), // negotiated down
            _ => panic!("expected welcome"),
        }
    }

    #[test]
    fn set_bypass_updates_and_reports_status() {
        let mut s = Session::new();
        let out = s.handle(ClientMessage::SetBypass { bypass: true });
        match &out[0] {
            ServerMessage::Status { bypass, .. } => assert!(*bypass),
            _ => panic!("expected status"),
        }
    }

    #[test]
    fn set_audio_clamps_and_reports_config() {
        let mut s = Session::new();
        let out = s.handle(ClientMessage::SetAudio {
            input_device_id: None,
            output_device_id: None,
            sample_rate: Some(999_999),
            buffer_frames: Some(1),
        });
        match &out[0] {
            ServerMessage::Status {
                sample_rate,
                buffer_frames,
                running,
                ..
            } => {
                assert_eq!(*sample_rate, 192_000); // clamped
                assert_eq!(*buffer_frames, 16); // clamped
                assert!(!*running); // no engine in Task A
            }
            _ => panic!("expected status"),
        }
    }
}
