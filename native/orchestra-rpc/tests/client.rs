//! In-process integration tests: a `std::os::unix::net::UnixListener` mock
//! backend speaking the wire protocol (docs/ui-rpc-protocol.md) end-to-end
//! against `RpcClient` — handshake, request/response, events, binary PTY
//! frames, ping/pong, proto-mismatch rejection, timeouts, and reconnect.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

use orchestra_rpc::client::{BackoffPolicy, ClientOptions, ConnectionState, RpcClient, RpcError};
use orchestra_rpc::events::UiEvent;
use orchestra_rpc::frame::{encode, Decoder, Frame};
use orchestra_rpc::protocol::BackendKind;

const RECV_TIMEOUT: Duration = Duration::from_secs(5);

fn test_socket_path(name: &str) -> PathBuf {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(dir).join(format!("orpc-{}-{seq}-{name}.sock", std::process::id()))
}

fn fast_opts() -> ClientOptions {
    ClientOptions {
        app_version: "test".into(),
        call_timeout: Duration::from_secs(5),
        handshake_timeout: Duration::from_secs(5),
        backoff: BackoffPolicy {
            base_ms: 20,
            factor: 1.0,
            max_delay_ms: 20,
            max_elapsed_ms: 5_000,
        },
        ..ClientOptions::default()
    }
}

// -- mock-server plumbing ---------------------------------------------------

struct ServerConn {
    stream: UnixStream,
    decoder: Decoder,
}

impl ServerConn {
    fn new(stream: UnixStream) -> Self {
        stream.set_read_timeout(Some(RECV_TIMEOUT)).unwrap();
        Self {
            stream,
            decoder: Decoder::new(),
        }
    }

    fn read_frame(&mut self) -> Frame {
        let mut buf = [0u8; 16 * 1024];
        loop {
            if let Some(f) = self.decoder.next_frame().expect("decode") {
                return f;
            }
            let n = self.stream.read(&mut buf).expect("server read");
            assert!(n > 0, "client closed while the server expected a frame");
            self.decoder.feed(&buf[..n]);
        }
    }

    fn read_json(&mut self) -> Value {
        match self.read_frame() {
            Frame::Json(v) => v,
            other => panic!("expected a JSON frame, got {other:?}"),
        }
    }

    fn write_frame(&mut self, f: &Frame) {
        self.stream.write_all(&encode(f).unwrap()).unwrap();
    }

    fn write_json(&mut self, v: Value) {
        self.write_frame(&Frame::Json(v));
    }

    /// Expect `hello`, answer `helloOk` (with `proto`), return the hello.
    fn handshake(&mut self, proto: u32) -> Value {
        let hello = self.read_json();
        assert_eq!(hello["t"], "hello");
        assert_eq!(hello["proto"], 1);
        self.write_json(json!({
            "t": "helloOk", "proto": proto, "appVersion": "0.5.84-test",
            "backendKind": "daemon"
        }));
        hello
    }
}

fn expect_state(rx: &std::sync::mpsc::Receiver<ConnectionState>) -> ConnectionState {
    rx.recv_timeout(RECV_TIMEOUT).expect("state event")
}

// ---------------------------------------------------------------------------

#[test]
fn full_flow_handshake_call_event_pty_ping() {
    let path = test_socket_path("full");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();

    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut conn = ServerConn::new(stream);
        let hello = conn.handshake(1);
        assert_eq!(hello["clientKind"], "gtk");

        // One req/res roundtrip.
        let req = conn.read_json();
        assert_eq!(req["t"], "req");
        assert_eq!(req["method"], "listWorkspaces");
        assert_eq!(req["params"], json!([]));
        let ws = json!({
            "id": "ws-1", "name": "repo · b", "repoPath": "/r", "worktreePath": "/w",
            "branch": "b", "baseBranch": "main", "createdAt": 1i64,
            "status": "waiting", "agent": "claude"
        });
        conn.write_json(json!({"t": "res", "id": req["id"], "ok": true, "result": [ws]}));

        // A frame type from the future must be ignored, not fatal.
        conn.write_json(json!({"t": "someFutureFrame", "payload": 42}));
        // One JSON event.
        conn.write_json(json!({
            "t": "event", "channel": "agentFinished", "args": ["ws-1", false]
        }));
        // One binary ptyData frame.
        conn.write_frame(&Frame::PtyData {
            id: "ws-1".into(),
            bytes: b"\x1b[1mhi\r\n".to_vec(),
        });
        // Server-initiated ping → client must pong.
        conn.write_json(json!({"t": "ping"}));

        // Client now sends (in whatever order the reader thread interleaves
        // them): pong (from the ping), focus, binary ptyWrite, and a second
        // req that gets a failing res. Collect until all four arrived.
        let mut got_pong = false;
        let mut got_focus = false;
        let mut got_pty_write = false;
        let mut got_req2 = false;
        while !(got_pong && got_focus && got_pty_write && got_req2) {
            match conn.read_frame() {
                Frame::Json(v) if v["t"] == "pong" => got_pong = true,
                Frame::Json(v) if v["t"] == "req" => {
                    assert_eq!(v["method"], "getAppVersion");
                    conn.write_json(json!({
                        "t": "res", "id": v["id"], "ok": false,
                        "error": {"message": "nope", "name": "TestError"}
                    }));
                    got_req2 = true;
                }
                Frame::Json(v) if v["t"] == "focus" => {
                    assert_eq!(v["focused"], true);
                    got_focus = true;
                }
                Frame::PtyWrite { id, bytes } => {
                    assert_eq!(id, "ws-1");
                    assert_eq!(bytes, b"ls\r".to_vec());
                    got_pty_write = true;
                }
                other => panic!("unexpected frame from client: {other:?}"),
            }
        }
        // Hold the connection until the client closes it deliberately.
        let mut buf = [0u8; 1024];
        loop {
            match conn.stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });

    let (client, rx) = RpcClient::connect(&path, fast_opts()).unwrap();
    assert_eq!(expect_state(&rx.state), ConnectionState::Connected);
    let info = client.server_info().unwrap();
    assert_eq!(info.app_version, "0.5.84-test");
    assert_eq!(info.backend_kind, BackendKind::Daemon);
    assert!(client.is_connected());

    // Typed call.
    let workspaces = client.list_workspaces().unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0].id, "ws-1");

    // Backend rejection surfaces as a typed remote error.
    match client.get_app_version() {
        Err(RpcError::Remote { message, name }) => {
            assert_eq!(message, "nope");
            assert_eq!(name.as_deref(), Some("TestError"));
        }
        other => panic!("expected remote error, got {other:?}"),
    }

    // Event, decoded.
    let ev = rx.events.recv_timeout(RECV_TIMEOUT).unwrap();
    assert_eq!(
        ev.decode().unwrap(),
        UiEvent::AgentFinished {
            id: "ws-1".into(),
            focused: false
        }
    );

    // Binary PTY output on its dedicated channel.
    let (pty_id, bytes) = rx.pty.recv_timeout(RECV_TIMEOUT).unwrap();
    assert_eq!(pty_id, "ws-1");
    assert_eq!(bytes, b"\x1b[1mhi\r\n".to_vec());

    // Client-side sends the server thread asserts on.
    client.focus(true).unwrap();
    client.send_pty_write("ws-1", b"ls\r").unwrap();

    // Deliberate close: terminal Disconnected, no reconnect.
    client.close();
    assert_eq!(expect_state(&rx.state), ConnectionState::Disconnected);
    assert!(!client.is_connected());
    server.join().unwrap();

    let _ = std::fs::remove_file(&path);
}

#[test]
fn proto_mismatch_is_rejected_with_typed_error() {
    let path = test_socket_path("proto");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut conn = ServerConn::new(stream);
        conn.handshake(2); // wrong protocol revision
    });
    match RpcClient::connect(&path, fast_opts()) {
        Err(RpcError::ProtoMismatch { server }) => assert_eq!(server, 2),
        other => panic!(
            "expected ProtoMismatch, got {:?}",
            other.map(|_| "connected")
        ),
    }
    server.join().unwrap();
    let _ = std::fs::remove_file(&path);
}

#[test]
fn call_times_out_when_backend_never_answers() {
    let path = test_socket_path("timeout");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut conn = ServerConn::new(stream);
        conn.handshake(1);
        let _req = conn.read_json(); // swallow the request, never respond
        std::thread::sleep(Duration::from_millis(300));
    });
    let (client, rx) = RpcClient::connect(&path, fast_opts()).unwrap();
    assert_eq!(expect_state(&rx.state), ConnectionState::Connected);
    match client.call_with_timeout("listRepos", vec![], Duration::from_millis(100)) {
        Err(RpcError::Timeout { method }) => assert_eq!(method, "listRepos"),
        other => panic!("expected Timeout, got {other:?}"),
    }
    client.close();
    server.join().unwrap();
    let _ = std::fs::remove_file(&path);
}

#[test]
fn reconnects_after_drop_and_resumes_calls() {
    let path = test_socket_path("reconnect");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();

    let path_for_server = path.clone();
    let server = std::thread::spawn(move || {
        // Generation 1: handshake, then rebind the path and drop the socket.
        let (stream, _) = listener.accept().unwrap();
        let mut conn = ServerConn::new(stream);
        conn.handshake(1);
        std::fs::remove_file(&path_for_server).unwrap();
        let listener2 = UnixListener::bind(&path_for_server).unwrap();
        drop(conn); // unexpected drop → client must reconnect
        drop(listener);

        // Generation 2: handshake again, answer one call.
        let (stream, _) = listener2.accept().unwrap();
        let mut conn = ServerConn::new(stream);
        conn.handshake(1);
        let req = conn.read_json();
        assert_eq!(req["method"], "getAppVersion");
        conn.write_json(json!({"t": "res", "id": req["id"], "ok": true, "result": "0.5.85"}));
        // Wait for the client's deliberate close.
        let mut buf = [0u8; 64];
        while matches!(conn.stream.read(&mut buf), Ok(n) if n > 0) {}
    });

    let (client, rx) = RpcClient::connect(&path, fast_opts()).unwrap();
    assert_eq!(expect_state(&rx.state), ConnectionState::Connected);

    // Drop → Reconnecting{attempt 0} → Connected on the fresh listener.
    match expect_state(&rx.state) {
        ConnectionState::Reconnecting {
            attempt: 0,
            delay_ms,
        } => assert_eq!(delay_ms, 20),
        other => panic!("expected Reconnecting, got {other:?}"),
    }
    assert_eq!(expect_state(&rx.state), ConnectionState::Connected);

    // The reconnected session serves calls again.
    assert_eq!(client.get_app_version().unwrap(), "0.5.85");

    client.close();
    assert_eq!(expect_state(&rx.state), ConnectionState::Disconnected);
    server.join().unwrap();
    let _ = std::fs::remove_file(&path);
}

#[test]
fn gives_up_reconnecting_after_the_backoff_window() {
    let path = test_socket_path("giveup");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    let path_for_server = path.clone();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut conn = ServerConn::new(stream);
        conn.handshake(1);
        // Vanish for good: no socket left to dial.
        std::fs::remove_file(&path_for_server).unwrap();
    });

    let mut opts = fast_opts();
    opts.backoff = BackoffPolicy {
        base_ms: 10,
        factor: 1.0,
        max_delay_ms: 10,
        max_elapsed_ms: 60,
    };
    let (client, rx) = RpcClient::connect(&path, opts).unwrap();
    assert_eq!(expect_state(&rx.state), ConnectionState::Connected);
    server.join().unwrap();

    // A few Reconnecting attempts, then a terminal Disconnected.
    let mut saw_reconnecting = false;
    loop {
        match expect_state(&rx.state) {
            ConnectionState::Reconnecting { .. } => saw_reconnecting = true,
            ConnectionState::Disconnected => break,
            ConnectionState::Connected => panic!("must not connect — the socket is gone"),
        }
    }
    assert!(saw_reconnecting);
    // Calls now fail fast.
    assert!(matches!(client.list_repos(), Err(RpcError::NotConnected)));
}

#[test]
fn discovery_reads_env_then_pointer_file() {
    // Explicit env override wins. (Env mutation is process-global — this test
    // is the only one touching these vars, and it restores them.)
    let dir = test_socket_path("discover-dir");
    std::fs::create_dir_all(&dir).unwrap();
    let pointer = dir.join("ui-sock");
    std::fs::write(&pointer, "/run/user/1/orchestra-ui-42.sock\n").unwrap();

    let prev_sock = std::env::var_os("ORCHESTRA_UI_SOCK");
    let prev_home = std::env::var_os("ORCHESTRA_HOME");
    std::env::set_var("ORCHESTRA_UI_SOCK", "/tmp/explicit.sock");
    assert_eq!(
        orchestra_rpc::discover_socket_path().unwrap(),
        PathBuf::from("/tmp/explicit.sock")
    );
    std::env::remove_var("ORCHESTRA_UI_SOCK");
    std::env::set_var("ORCHESTRA_HOME", &dir);
    assert_eq!(
        orchestra_rpc::discover_socket_path().unwrap(),
        PathBuf::from("/run/user/1/orchestra-ui-42.sock")
    );
    match prev_sock {
        Some(v) => std::env::set_var("ORCHESTRA_UI_SOCK", v),
        None => std::env::remove_var("ORCHESTRA_UI_SOCK"),
    }
    match prev_home {
        Some(v) => std::env::set_var("ORCHESTRA_HOME", v),
        None => std::env::remove_var("ORCHESTRA_HOME"),
    }
    let _ = std::fs::remove_file(&pointer);
    let _ = std::fs::remove_dir(&dir);
}
