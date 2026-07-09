//! mfx native companion — a headless, low-latency local audio I/O engine
//! controlled from the mfx browser app over localhost.
//!
//! Task A scope: localhost WebSocket control plane + device enumeration. The
//! real-time audio engine is wired in Task B; the effect subset in Task C.

use mfx_native_companion::{protocol, server};
use tokio::net::TcpListener;

/// Loopback-only. The browser probes this fixed port and completes the
/// handshake. Deliberately not `0.0.0.0` — no LAN exposure in the MVP.
const DEFAULT_PORT: u16 = 8730;
const BIND_ADDR: &str = "127.0.0.1";

fn resolve_port() -> u16 {
    // `--port N` wins over `MFX_COMPANION_PORT`, which wins over the default.
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--port" {
            if let Some(v) = args.next().and_then(|s| s.parse().ok()) {
                return v;
            }
        } else if let Some(v) = arg.strip_prefix("--port=").and_then(|s| s.parse().ok()) {
            return v;
        }
    }
    std::env::var("MFX_COMPANION_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

#[tokio::main]
async fn main() {
    let port = resolve_port();
    let addr = format!("{BIND_ADDR}:{port}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!(
                "[mfx-native] could not bind {addr}: {e}\n\
                 Another instance may already be running, or the port is in use.\n\
                 Set MFX_COMPANION_PORT or pass --port to choose another."
            );
            std::process::exit(1);
        }
    };
    eprintln!(
        "[mfx-native] mfx native companion {} listening on ws://{addr} (loopback only)",
        protocol::COMPANION_VERSION
    );

    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    tokio::spawn(server::run_session(stream, peer.to_string()));
                }
                Err(e) => eprintln!("[mfx-native] accept error: {e}"),
            },
            _ = tokio::signal::ctrl_c() => {
                eprintln!("[mfx-native] shutting down");
                break;
            }
        }
    }
}
