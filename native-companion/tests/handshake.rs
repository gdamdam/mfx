//! End-to-end test of the WebSocket control loop over an in-memory duplex pipe.
//! Exercises `accept_async` + framing + `Session::handle` round-trip without
//! binding a TCP port (not always permitted in CI/sandboxes).

use futures_util::{SinkExt, StreamExt};
use mfx_native_companion::server::run_session;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn hello_over_websocket_returns_welcome() {
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);

    // Server side: run one session against the server end of the pipe.
    let server = tokio::spawn(run_session(server_io, "test-peer".into()));

    // Client side: complete the WS handshake and speak the protocol.
    let (mut ws, _resp) = tokio_tungstenite::client_async("ws://localhost/", client_io)
        .await
        .expect("client handshake");

    ws.send(Message::Text(
        r#"{"type":"hello","client":"mfx","protocol":1}"#.into(),
    ))
    .await
    .unwrap();

    let reply = next_json(&mut ws).await;
    assert_eq!(reply["type"], "welcome");
    assert_eq!(reply["protocol"], 1);
    assert_eq!(reply["capabilities"][0], "native-audio");

    // An unknown message type must be silently dropped (no reply, no crash),
    // and a subsequent valid message must still be answered.
    ws.send(Message::Text(r#"{"type":"totally-unknown"}"#.into()))
        .await
        .unwrap();
    ws.send(Message::Text(
        r#"{"type":"setBypass","bypass":true}"#.into(),
    ))
    .await
    .unwrap();

    let reply = next_json(&mut ws).await;
    assert_eq!(reply["type"], "status");
    assert_eq!(reply["bypass"], true);

    ws.close(None).await.unwrap();
    let _ = server.await;
}

async fn next_json<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>) -> serde_json::Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        match ws.next().await.expect("a frame").expect("ok frame") {
            Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            _ => continue,
        }
    }
}
