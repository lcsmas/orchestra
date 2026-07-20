//! Blocking UI-RPC client (docs/ui-rpc-protocol.md).
//!
//! Dependency-light by design: `std::os::unix::net::UnixStream` plus a reader
//! thread per connection — no async runtime. The GTK consumer integrates via
//! the three `mpsc` receivers handed back from [`RpcClient::connect`]:
//! JSON events, raw PTY bytes, and connection-state transitions.
//!
//! Reconnect policy mirrors the sandbox transport's
//! (`src/main/transport/reconnect-policy.ts`): exponential backoff
//! 1s → 2s → … → 30s cap, give-up after 3 minutes, surfaced as
//! [`ConnectionState`] events. A deliberate [`RpcClient::close`] never
//! reconnects.
//!
//! Method surface = `OrchestraAPI` (`src/shared/ipc.ts`) verbatim, as typed
//! wrappers, plus the three M1 protocol additions (`deps:status`, `app:info`,
//! `pty:scrollback`). One member is deliberately absent: `pickDirectory` is
//! frontend-local (native file chooser) and not served over RPC — protocol §4.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::base64;
use crate::events::Event;
use crate::frame::{encode, Decoder, Frame};
use crate::protocol::{BackendKind, ClientKind, JsonFrame, ResError, PROTO_VERSION};
use crate::types::*;

// ---------------------------------------------------------------------------
// Options / policy / errors

/// Exponential backoff schedule, mirroring
/// `src/main/transport/reconnect-policy.ts` (same defaults).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackoffPolicy {
    /// First retry delay.
    pub base_ms: u64,
    /// Multiplier per attempt.
    pub factor: f64,
    /// Ceiling for any single delay.
    pub max_delay_ms: u64,
    /// Total time (including the delay about to be slept) before giving up.
    pub max_elapsed_ms: u64,
}

impl Default for BackoffPolicy {
    /// 1s → 2s → 4s → 8s → 16s → 30s → 30s … give up after 3 minutes.
    fn default() -> Self {
        Self {
            base_ms: 1_000,
            factor: 2.0,
            max_delay_ms: 30_000,
            max_elapsed_ms: 180_000,
        }
    }
}

impl BackoffPolicy {
    /// Delay before retry number `attempt` (0-based).
    pub fn delay_ms(&self, attempt: u32) -> u64 {
        let raw = self.base_ms as f64 * self.factor.powi(attempt as i32);
        (raw.round() as u64).min(self.max_delay_ms)
    }

    /// True when the loop should stop retrying, called BEFORE sleeping with
    /// the elapsed time the upcoming delay would bring us to.
    pub fn should_give_up(&self, elapsed_ms_including_next_delay: u64) -> bool {
        elapsed_ms_including_next_delay > self.max_elapsed_ms
    }
}

/// Client configuration. `Default` is what the GTK app wants.
#[derive(Debug, Clone)]
pub struct ClientOptions {
    /// Sent in `hello.clientKind`.
    pub client_kind: ClientKind,
    /// Sent in `hello.appVersion`.
    pub app_version: String,
    /// Initial focus state sent in `hello.focused`.
    pub focused: bool,
    /// Default per-call timeout for [`RpcClient::call`].
    pub call_timeout: Duration,
    /// Timeout for connect + hello/helloOk.
    pub handshake_timeout: Duration,
    /// Idle time before the client sends a `ping` (protocol: 15s).
    pub ping_idle: Duration,
    /// How long to wait for traffic after a `ping` before declaring the
    /// connection dead (protocol: reply within 5s).
    pub pong_timeout: Duration,
    /// Reconnect schedule after an unexpected drop.
    pub backoff: BackoffPolicy,
    /// Set false to disable automatic reconnect entirely.
    pub reconnect: bool,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            client_kind: ClientKind::Gtk,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            focused: false,
            call_timeout: Duration::from_secs(30),
            handshake_timeout: Duration::from_secs(10),
            ping_idle: Duration::from_secs(15),
            pong_timeout: Duration::from_secs(5),
            backoff: BackoffPolicy::default(),
            reconnect: true,
        }
    }
}

/// Connection lifecycle, delivered on the state receiver. `Connected` is also
/// emitted for the initial connection; `Disconnected` is terminal (deliberate
/// close, reconnect disabled, give-up, or a fatal proto mismatch).
#[derive(Debug, Clone, PartialEq)]
pub enum ConnectionState {
    Connected,
    Reconnecting { attempt: u32, delay_ms: u64 },
    Disconnected,
}

/// What the backend said in `helloOk`.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerInfo {
    pub app_version: String,
    pub backend_kind: BackendKind,
}

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame error: {0}")]
    Frame(#[from] crate::frame::FrameError),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("backend speaks protocol {server}, this client speaks {PROTO_VERSION}")]
    ProtoMismatch { server: u32 },
    #[error("handshake failed: {0}")]
    Handshake(String),
    #[error("socket discovery failed: {0}")]
    Discovery(String),
    #[error("not connected")]
    NotConnected,
    #[error("connection lost")]
    ConnectionLost,
    #[error("call '{method}' timed out")]
    Timeout { method: String },
    #[error("backend error{}: {message}", name.as_deref().map(|n| format!(" ({n})")).unwrap_or_default())]
    Remote {
        message: String,
        name: Option<String>,
    },
    #[error("bad payload: {0}")]
    BadPayload(String),
}

// ---------------------------------------------------------------------------
// Discovery

/// Resolve the backend socket path: `$ORCHESTRA_UI_SOCK`, else the `ui-sock`
/// pointer file under `$ORCHESTRA_HOME` (default `~/.orchestra`).
pub fn discover_socket_path() -> Result<PathBuf, RpcError> {
    let non_empty = |v: std::result::Result<String, std::env::VarError>| {
        v.ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    if let Some(p) = non_empty(std::env::var("ORCHESTRA_UI_SOCK")) {
        return Ok(PathBuf::from(p));
    }
    let home = match non_empty(std::env::var("ORCHESTRA_HOME")) {
        Some(h) => PathBuf::from(h),
        None => match non_empty(std::env::var("HOME")) {
            Some(h) => PathBuf::from(h).join(".orchestra"),
            None => {
                return Err(RpcError::Discovery(
                    "neither ORCHESTRA_UI_SOCK, ORCHESTRA_HOME nor HOME is set".into(),
                ))
            }
        },
    };
    read_pointer(&home.join("ui-sock"))
}

/// Read a `ui-sock` pointer file and return the socket path it names. Split out
/// of [`discover_socket_path`] so a caller can point at an explicit pointer file
/// without going through process-global env (see [`RpcClient::discover_at`]).
pub fn read_pointer(pointer: &Path) -> Result<PathBuf, RpcError> {
    let content = std::fs::read_to_string(pointer).map_err(|e| {
        RpcError::Discovery(format!(
            "no backend socket pointer at {}: {e}",
            pointer.display()
        ))
    })?;
    let path = content.trim();
    if path.is_empty() {
        return Err(RpcError::Discovery(format!(
            "{} is empty",
            pointer.display()
        )));
    }
    Ok(PathBuf::from(path))
}

// ---------------------------------------------------------------------------
// Client internals

#[derive(Debug, Clone)]
enum Source {
    /// Reconnect redials this exact path.
    Explicit(PathBuf),
    /// Reconnect re-reads THIS pointer file (same self-healing behaviour as
    /// `Discovered`, but aimed at an explicit pointer instead of resolving one
    /// from the environment — so callers, and tests, need no global env).
    Pointer(PathBuf),
    /// Reconnect re-runs discovery (the backend may have restarted under a
    /// new pid-derived socket path).
    Discovered,
}

struct Shared {
    opts: ClientOptions,
    source: Source,
    /// Write half of the live connection; `None` while down.
    writer: Mutex<Option<UnixStream>>,
    pending: Mutex<HashMap<u32, SyncSender<Result<Value, RpcError>>>>,
    server_info: Mutex<Option<ServerInfo>>,
    next_id: AtomicU32,
    /// Bumped on every (re)connect; stale reader/keepalive threads use it to
    /// detect they've been superseded.
    generation: AtomicU64,
    focused: AtomicBool,
    closed: AtomicBool,
    reconnecting: AtomicBool,
    /// Why the most recent reconnect attempt failed, categorised
    /// (discovery / connect / handshake). Diagnostic only — the reconnect loop
    /// treats every failure the same, but WHICH failure it was is what
    /// distinguishes "the pointer was missing so we never dialled" from "we
    /// dialled and were refused". See its write site in `reconnect_loop`.
    last_retry_error: Mutex<Option<String>>,
    /// Millis (since `epoch`) of the last byte received.
    last_rx_ms: AtomicU64,
    epoch: Instant,
    events_tx: Sender<Event>,
    pty_tx: Sender<(String, Vec<u8>)>,
    state_tx: Sender<ConnectionState>,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    fn send_state(&self, s: ConnectionState) {
        let _ = self.state_tx.send(s);
    }

    fn write_frame(&self, frame: &Frame) -> Result<(), RpcError> {
        let bytes = encode(frame)?;
        let guard = self.writer.lock().expect("writer lock");
        match guard.as_ref() {
            Some(mut stream) => {
                stream.write_all(&bytes)?;
                Ok(())
            }
            None => Err(RpcError::NotConnected),
        }
    }

    fn write_json(&self, frame: &JsonFrame) -> Result<(), RpcError> {
        self.write_frame(&Frame::Json(serde_json::to_value(frame)?))
    }

    /// Best-effort shutdown of the live socket (wakes the reader thread).
    fn shutdown_socket(&self) {
        if let Some(s) = self.writer.lock().expect("writer lock").as_ref() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }

    fn fail_pending(&self, err: impl Fn() -> RpcError) {
        let mut pending = self.pending.lock().expect("pending lock");
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(err()));
        }
    }
}

/// The receiving ends handed to the consumer: JSON events, PTY output
/// (`(id, bytes)` per binary `ptyData` frame), and connection-state changes.
pub struct Receivers {
    pub events: Receiver<Event>,
    pub pty: Receiver<(String, Vec<u8>)>,
    pub state: Receiver<ConnectionState>,
}

/// Blocking UI-RPC client. Cheap to clone; all clones share one connection.
#[derive(Clone)]
pub struct RpcClient {
    shared: Arc<Shared>,
}

impl RpcClient {
    /// Connect to an explicit socket path and perform the hello handshake.
    pub fn connect(
        path: impl AsRef<Path>,
        opts: ClientOptions,
    ) -> Result<(Self, Receivers), RpcError> {
        Self::connect_inner(Source::Explicit(path.as_ref().to_path_buf()), opts)
    }

    /// Discover the backend socket (env `ORCHESTRA_UI_SOCK`, then the
    /// `ui-sock` pointer file under `$ORCHESTRA_HOME` / `~/.orchestra`) and
    /// connect. Reconnects re-run discovery.
    pub fn discover(opts: ClientOptions) -> Result<(Self, Receivers), RpcError> {
        Self::connect_inner(Source::Discovered, opts)
    }

    /// Like [`Self::discover`], but resolving an EXPLICIT `ui-sock` pointer file
    /// instead of one derived from the environment. Reconnects re-read that
    /// pointer, so a backend restarting under a new socket path is still picked
    /// up — the same self-healing behaviour, without depending on (or mutating)
    /// process-global env. Useful for a caller managing several homes, and it
    /// lets tests exercise re-discovery without racing each other's env.
    pub fn discover_at(
        pointer: impl AsRef<Path>,
        opts: ClientOptions,
    ) -> Result<(Self, Receivers), RpcError> {
        Self::connect_inner(Source::Pointer(pointer.as_ref().to_path_buf()), opts)
    }

    fn connect_inner(source: Source, opts: ClientOptions) -> Result<(Self, Receivers), RpcError> {
        let (events_tx, events_rx) = mpsc::channel();
        let (pty_tx, pty_rx) = mpsc::channel();
        let (state_tx, state_rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            focused: AtomicBool::new(opts.focused),
            opts,
            source,
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            server_info: Mutex::new(None),
            next_id: AtomicU32::new(1),
            generation: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            reconnecting: AtomicBool::new(false),
            last_retry_error: Mutex::new(None),
            last_rx_ms: AtomicU64::new(0),
            epoch: Instant::now(),
            events_tx,
            pty_tx,
            state_tx,
        });
        let (stream, decoder, info) = dial(&shared)?;
        // Emit Connected BEFORE spawning the reader: a connection that dies
        // instantly must not get its Reconnecting event ahead of this one.
        shared.send_state(ConnectionState::Connected);
        install_connection(&shared, stream, decoder, info);
        Ok((
            Self { shared },
            Receivers {
                events: events_rx,
                pty: pty_rx,
                state: state_rx,
            },
        ))
    }

    /// What the backend reported in `helloOk` (None only before the first
    /// successful handshake — i.e. never, once `connect` returned).
    pub fn server_info(&self) -> Option<ServerInfo> {
        self.shared
            .server_info
            .lock()
            .expect("server_info lock")
            .clone()
    }

    /// Why the last reconnect attempt failed, categorised — `None` before any
    /// retry has failed. Diagnostic surface for harnesses investigating
    /// reconnect behaviour (M4 D1b): it separates "never dialled, the pointer
    /// was absent" from "dialled and refused", which the loop itself collapses.
    pub fn last_retry_error(&self) -> Option<String> {
        self.shared.last_retry_error.lock().ok()?.clone()
    }

    pub fn is_connected(&self) -> bool {
        self.shared.writer.lock().expect("writer lock").is_some()
    }

    /// Deliberately close the connection. No reconnect follows; the state
    /// receiver sees a final `Disconnected`.
    pub fn close(&self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        self.shared.shutdown_socket();
    }

    // -- raw surface --------------------------------------------------------

    /// Send `req` and block for its `res` (default timeout).
    pub fn call(&self, method: &str, params: Vec<Value>) -> Result<Value, RpcError> {
        self.call_with_timeout(method, params, self.shared.opts.call_timeout)
    }

    /// Send `req` and block for its `res`, correlated by id, up to `timeout`.
    pub fn call_with_timeout(
        &self,
        method: &str,
        params: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        self.shared
            .pending
            .lock()
            .expect("pending lock")
            .insert(id, tx);
        let req = JsonFrame::Req {
            id,
            method: method.to_string(),
            params,
        };
        if let Err(e) = self.shared.write_json(&req) {
            self.shared
                .pending
                .lock()
                .expect("pending lock")
                .remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.shared
                    .pending
                    .lock()
                    .expect("pending lock")
                    .remove(&id);
                Err(RpcError::Timeout {
                    method: method.to_string(),
                })
            }
        }
    }

    /// Report the frontend's focus state (`focus` frame). Also remembered for
    /// the next reconnect's `hello`.
    pub fn focus(&self, focused: bool) -> Result<(), RpcError> {
        self.shared.focused.store(focused, Ordering::SeqCst);
        self.shared.write_json(&JsonFrame::Focus { focused })
    }

    /// Fast-path PTY input: a binary `ptyWrite` frame (no response).
    pub fn send_pty_write(&self, id: &str, bytes: &[u8]) -> Result<(), RpcError> {
        self.shared.write_frame(&Frame::PtyWrite {
            id: id.to_string(),
            bytes: bytes.to_vec(),
        })
    }

    fn call_as<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: Vec<Value>,
    ) -> Result<T, RpcError> {
        let v = self.call(method, params)?;
        Ok(serde_json::from_value(v)?)
    }

    fn call_unit(&self, method: &str, params: Vec<Value>) -> Result<(), RpcError> {
        self.call(method, params).map(|_| ())
    }
}

// ---------------------------------------------------------------------------
// Connection plumbing

/// Connect + handshake. Returns the stream, the streaming decoder (it may
/// already hold bytes that arrived after `helloOk`), and the server info.
fn dial(shared: &Arc<Shared>) -> Result<(UnixStream, Decoder, ServerInfo), RpcError> {
    let path = match &shared.source {
        Source::Explicit(p) => p.clone(),
        Source::Pointer(p) => read_pointer(p)?,
        Source::Discovered => discover_socket_path()?,
    };
    let stream = UnixStream::connect(&path)?;
    stream.set_read_timeout(Some(shared.opts.handshake_timeout))?;
    stream.set_write_timeout(Some(shared.opts.handshake_timeout))?;

    let hello = JsonFrame::Hello {
        proto: PROTO_VERSION,
        app_version: shared.opts.app_version.clone(),
        client_kind: shared.opts.client_kind,
        focused: shared.focused.load(Ordering::SeqCst),
    };
    (&stream).write_all(&encode(&Frame::Json(serde_json::to_value(&hello)?))?)?;

    let mut decoder = Decoder::new();
    let mut buf = [0u8; 16 * 1024];
    let deadline = Instant::now() + shared.opts.handshake_timeout;
    loop {
        while let Some(frame) = decoder.next_frame()? {
            if let Frame::Json(v) = frame {
                if v.get("t").and_then(Value::as_str) == Some("helloOk") {
                    let ok: JsonFrame = serde_json::from_value(v)?;
                    let JsonFrame::HelloOk {
                        proto,
                        app_version,
                        backend_kind,
                    } = ok
                    else {
                        unreachable!("t=helloOk parsed to another variant");
                    };
                    if proto != PROTO_VERSION {
                        return Err(RpcError::ProtoMismatch { server: proto });
                    }
                    stream.set_read_timeout(None)?;
                    return Ok((
                        stream,
                        decoder,
                        ServerInfo {
                            app_version,
                            backend_kind,
                        },
                    ));
                }
                // Anything else before helloOk is a protocol violation; skip
                // it rather than dying — the backend may pipeline events.
            }
        }
        if Instant::now() >= deadline {
            return Err(RpcError::Handshake("timed out waiting for helloOk".into()));
        }
        let n = (&stream).read(&mut buf).map_err(|e| {
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) {
                RpcError::Handshake("timed out waiting for helloOk".into())
            } else {
                RpcError::Io(e)
            }
        })?;
        if n == 0 {
            return Err(RpcError::Handshake(
                "backend closed during handshake".into(),
            ));
        }
        decoder.feed(&buf[..n]);
    }
}

/// Install a freshly-handshaken connection and start its reader + keepalive
/// threads.
fn install_connection(
    shared: &Arc<Shared>,
    stream: UnixStream,
    decoder: Decoder,
    info: ServerInfo,
) {
    let generation = shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let write_half = stream.try_clone().expect("unix stream clone");
    *shared.writer.lock().expect("writer lock") = Some(write_half);
    *shared.server_info.lock().expect("server_info lock") = Some(info);
    shared.last_rx_ms.store(shared.now_ms(), Ordering::SeqCst);

    let s = Arc::clone(shared);
    std::thread::Builder::new()
        .name("orpc-reader".into())
        .spawn(move || reader_loop(&s, stream, decoder, generation))
        .expect("spawn reader thread");

    let s = Arc::clone(shared);
    std::thread::Builder::new()
        .name("orpc-keepalive".into())
        .spawn(move || keepalive_loop(&s, generation))
        .expect("spawn keepalive thread");
}

fn reader_loop(shared: &Arc<Shared>, stream: UnixStream, mut decoder: Decoder, generation: u64) {
    let mut buf = [0u8; 64 * 1024];
    'outer: loop {
        loop {
            match decoder.next_frame() {
                Ok(Some(frame)) => dispatch_frame(shared, frame),
                Ok(None) => break,
                Err(_) => break 'outer, // stream corrupt — force a reconnect
            }
        }
        match (&stream).read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                shared.last_rx_ms.store(shared.now_ms(), Ordering::SeqCst);
                decoder.feed(&buf[..n]);
            }
        }
    }
    connection_lost(shared, generation);
}

fn dispatch_frame(shared: &Arc<Shared>, frame: Frame) {
    match frame {
        Frame::PtyData { id, bytes } => {
            let _ = shared.pty_tx.send((id, bytes));
        }
        // S→C ptyWrite is not a thing; tolerate and drop.
        Frame::PtyWrite { .. } => {}
        Frame::Json(v) => dispatch_json(shared, v),
    }
}

fn dispatch_json(shared: &Arc<Shared>, v: Value) {
    // Tolerate unknown `t` values (newer backend) by matching before parsing.
    let t = v.get("t").and_then(Value::as_str).unwrap_or_default();
    match t {
        "res" => {
            let Ok(JsonFrame::Res {
                id,
                ok,
                result,
                error,
            }) = serde_json::from_value(v)
            else {
                return;
            };
            let tx = shared.pending.lock().expect("pending lock").remove(&id);
            if let Some(tx) = tx {
                let outcome = if ok {
                    Ok(result.unwrap_or(Value::Null))
                } else {
                    let ResError { message, name } = error.unwrap_or(ResError {
                        message: "unknown backend error".into(),
                        name: None,
                    });
                    Err(RpcError::Remote { message, name })
                };
                let _ = tx.send(outcome);
            }
        }
        "event" => {
            let Ok(JsonFrame::Event { channel, args }) = serde_json::from_value(v) else {
                return;
            };
            let _ = shared.events_tx.send(Event { channel, args });
        }
        "ping" => {
            let _ = shared.write_json(&JsonFrame::Pong);
        }
        // pong / helloOk / anything future: liveness already recorded.
        _ => {}
    }
}

fn keepalive_loop(shared: &Arc<Shared>, generation: u64) {
    let ping_idle = shared.opts.ping_idle.as_millis() as u64;
    let pong_timeout = shared.opts.pong_timeout.as_millis() as u64;
    let tick = Duration::from_millis((ping_idle.min(pong_timeout) / 4).clamp(25, 1_000));
    let mut ping_sent_at: Option<u64> = None;
    loop {
        std::thread::sleep(tick);
        if shared.closed.load(Ordering::SeqCst)
            || shared.generation.load(Ordering::SeqCst) != generation
        {
            return;
        }
        let now = shared.now_ms();
        let last_rx = shared.last_rx_ms.load(Ordering::SeqCst);
        if let Some(sent) = ping_sent_at {
            if last_rx >= sent {
                ping_sent_at = None; // any traffic since the ping proves liveness
            } else if now.saturating_sub(sent) > pong_timeout {
                shared.shutdown_socket(); // wakes the reader → reconnect path
                return;
            }
        }
        if ping_sent_at.is_none() && now.saturating_sub(last_rx) > ping_idle {
            ping_sent_at = Some(now);
            let _ = shared.write_json(&JsonFrame::Ping);
        }
    }
}

fn connection_lost(shared: &Arc<Shared>, generation: u64) {
    if shared.generation.load(Ordering::SeqCst) != generation {
        return; // a newer connection already superseded this one
    }
    *shared.writer.lock().expect("writer lock") = None;
    shared.fail_pending(|| RpcError::ConnectionLost);
    if shared.closed.load(Ordering::SeqCst) || !shared.opts.reconnect {
        shared.send_state(ConnectionState::Disconnected);
        return;
    }
    if shared.reconnecting.swap(true, Ordering::SeqCst) {
        return; // a reconnect loop is already running
    }
    let s = Arc::clone(shared);
    std::thread::Builder::new()
        .name("orpc-reconnect".into())
        .spawn(move || reconnect_loop(&s))
        .expect("spawn reconnect thread");
}

fn reconnect_loop(shared: &Arc<Shared>) {
    let policy = shared.opts.backoff;
    let start = Instant::now();
    let mut attempt: u32 = 0;
    loop {
        let delay = policy.delay_ms(attempt);
        let elapsed = start.elapsed().as_millis() as u64;
        if policy.should_give_up(elapsed + delay) {
            eprintln!(
                "[orchestra-rpc] reconnect giving up at attempt {attempt}: \
                 elapsed {elapsed}ms + delay {delay}ms exceeds {}ms",
                policy.max_elapsed_ms
            );
            shared.reconnecting.store(false, Ordering::SeqCst);
            shared.send_state(ConnectionState::Disconnected);
            return;
        }
        shared.send_state(ConnectionState::Reconnecting {
            attempt,
            delay_ms: delay,
        });
        std::thread::sleep(Duration::from_millis(delay));
        if shared.closed.load(Ordering::SeqCst) {
            shared.reconnecting.store(false, Ordering::SeqCst);
            shared.send_state(ConnectionState::Disconnected);
            return;
        }
        match dial(shared) {
            Ok((stream, decoder, info)) => {
                // State + flag BEFORE spawning the reader: if the fresh
                // connection dies instantly, its connection_lost must see
                // reconnecting == false (so it starts a new loop) and its
                // Reconnecting event must trail this Connected one.
                shared.send_state(ConnectionState::Connected);
                shared.reconnecting.store(false, Ordering::SeqCst);
                install_connection(shared, stream, decoder, info);
                return;
            }
            // A proto mismatch won't heal by retrying — surface and stop.
            Err(RpcError::ProtoMismatch { .. }) => {
                shared.reconnecting.store(false, Ordering::SeqCst);
                shared.send_state(ConnectionState::Disconnected);
                return;
            }
            Err(e) => {
                // WHY an attempt failed is three different facts, and the loop
                // used to discard all three identically. They distinguish real
                // causes: a DISCOVERY failure means we never even tried to
                // connect (the ui-sock pointer was absent — the real daemon
                // unlinks it on shutdown, so every redial in the gap before its
                // replacement writes one burns an attempt and inflates the
                // backoff), whereas a CONNECT or HANDSHAKE failure means we
                // reached a path and it refused. Diagnosing the reconnect
                // behaviour without this distinction is guesswork, so the
                // reason is recorded for `last_retry_error()` and traced.
                let kind = match &e {
                    RpcError::Discovery(_) => "discovery",
                    RpcError::Handshake(_) => "handshake",
                    RpcError::Io(_) => "connect",
                    _ => "other",
                };
                // ELAPSED is logged alongside attempt/kind because the three
                // together discriminate the candidate wedges, and no single
                // snapshot can:
                //   - attempt CLIMBING  → loop alive, retrying forever: the
                //     give-up exists but is never reached (suspect elapsed not
                //     accumulating the way should_give_up expects).
                //   - attempt STOPPED   → loop exited WITHOUT emitting
                //     Disconnected: a silent exit, a different bug entirely.
                // A stopped counter and a slowly-climbing one look identical in
                // one sample, so this is emitted EVERY attempt to give the
                // reader a sequence rather than a point.
                let elapsed_ms = start.elapsed().as_millis() as u64;
                let line = format!(
                    "attempt {attempt} failed ({kind}) after {elapsed_ms}ms \
                     of {}ms budget: {e}",
                    policy.max_elapsed_ms
                );
                if let Ok(mut slot) = shared.last_retry_error.lock() {
                    *slot = Some(line.clone());
                }
                eprintln!("[orchestra-rpc] reconnect {line}");
                attempt += 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Typed OrchestraAPI surface (src/shared/ipc.ts, verbatim member per member)

impl RpcClient {
    // -- Repos --------------------------------------------------------------

    pub fn add_repo(&self, abs_path: &str) -> Result<RepoEntry, RpcError> {
        self.call_as("addRepo", vec![json!(abs_path)])
    }

    pub fn remove_repo(&self, abs_path: &str) -> Result<(), RpcError> {
        self.call_unit("removeRepo", vec![json!(abs_path)])
    }

    pub fn list_repos(&self) -> Result<Vec<RepoEntry>, RpcError> {
        self.call_as("listRepos", vec![])
    }

    pub fn list_repo_sync_states(&self) -> Result<Vec<RepoSyncState>, RpcError> {
        self.call_as("listRepoSyncStates", vec![])
    }

    pub fn sync_repo_base(&self, repo_path: &str) -> Result<(), RpcError> {
        self.call_unit("syncRepoBase", vec![json!(repo_path)])
    }

    pub fn reorder_repos(&self, ordered_paths: &[String]) -> Result<(), RpcError> {
        self.call_unit("reorderRepos", vec![json!(ordered_paths)])
    }

    pub fn list_repo_branches(&self, repo_path: &str) -> Result<Vec<String>, RpcError> {
        self.call_as("listRepoBranches", vec![json!(repo_path)])
    }

    pub fn set_repo_default_branch(
        &self,
        repo_path: &str,
        branch: &str,
    ) -> Result<RepoEntry, RpcError> {
        self.call_as(
            "setRepoDefaultBranch",
            vec![json!(repo_path), json!(branch)],
        )
    }

    // `pickDirectory` is deliberately absent: frontend-local, not served over
    // RPC (docs/ui-rpc-protocol.md §4).

    /// Served, but frontends SHOULD open URLs locally (protocol §4).
    pub fn open_external(&self, url: &str) -> Result<(), RpcError> {
        self.call_unit("openExternal", vec![json!(url)])
    }

    pub fn get_app_version(&self) -> Result<String, RpcError> {
        self.call_as("getAppVersion", vec![])
    }

    pub fn get_env_status(&self) -> Result<Vec<EnvStatusItem>, RpcError> {
        self.call_as("getEnvStatus", vec![])
    }

    pub fn get_linear_key_source(&self) -> Result<LinearKeySource, RpcError> {
        self.call_as("getLinearKeySource", vec![])
    }

    pub fn check_linear_key(&self, key: &str) -> Result<LinearKeyCheck, RpcError> {
        self.call_as("checkLinearKey", vec![json!(key)])
    }

    pub fn save_linear_key(&self, key: &str) -> Result<(), RpcError> {
        self.call_unit("saveLinearKey", vec![json!(key)])
    }

    pub fn clear_linear_key(&self) -> Result<(), RpcError> {
        self.call_unit("clearLinearKey", vec![])
    }

    pub fn get_usage(&self) -> Result<Option<UsageSnapshot>, RpcError> {
        self.call_as("getUsage", vec![])
    }

    // -- Accounts -----------------------------------------------------------

    pub fn list_accounts(&self) -> Result<Vec<Account>, RpcError> {
        self.call_as("listAccounts", vec![])
    }

    pub fn set_accounts(&self, accounts: &[Account]) -> Result<Vec<Account>, RpcError> {
        self.call_as("setAccounts", vec![serde_json::to_value(accounts)?])
    }

    pub fn set_repo_account(
        &self,
        repo_path: &str,
        account_id: Option<&str>,
    ) -> Result<RepoEntry, RpcError> {
        self.call_as("setRepoAccount", vec![json!(repo_path), json!(account_id)])
    }

    pub fn migrate_workspace_account(
        &self,
        id: &str,
        account_id: Option<&str>,
    ) -> Result<MigrateAccountResult, RpcError> {
        self.call_as(
            "migrateWorkspaceAccount",
            vec![json!(id), json!(account_id)],
        )
    }

    pub fn get_account_usage(
        &self,
        account_id: &str,
    ) -> Result<Option<AccountUsageStatus>, RpcError> {
        self.call_as("getAccountUsage", vec![json!(account_id)])
    }

    pub fn get_all_account_usage(&self) -> Result<HashMap<String, AccountUsageStatus>, RpcError> {
        self.call_as("getAllAccountUsage", vec![])
    }

    pub fn get_workspace_accounts(&self) -> Result<HashMap<String, WorkspaceAccount>, RpcError> {
        self.call_as("getWorkspaceAccounts", vec![])
    }

    pub fn account_login_start(
        &self,
        account_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), RpcError> {
        self.call_unit(
            "accountLoginStart",
            vec![json!(account_id), json!(cols), json!(rows)],
        )
    }

    pub fn account_login_stop(&self, account_id: &str) -> Result<(), RpcError> {
        self.call_unit("accountLoginStop", vec![json!(account_id)])
    }

    pub fn account_login_open_url(&self, account_id: &str, url: &str) -> Result<(), RpcError> {
        self.call_unit("accountLoginOpenUrl", vec![json!(account_id), json!(url)])
    }

    pub fn refresh_accounts(&self) -> Result<(), RpcError> {
        self.call_unit("refreshAccounts", vec![])
    }

    pub fn list_global_inheritables(&self) -> Result<GlobalInheritables, RpcError> {
        self.call_as("listGlobalInheritables", vec![])
    }

    // -- Diagnostic logs ----------------------------------------------------

    pub fn reveal_logs(&self) -> Result<(), RpcError> {
        self.call_unit("revealLogs", vec![])
    }

    pub fn log_path(&self) -> Result<String, RpcError> {
        self.call_as("logPath", vec![])
    }

    pub fn log(
        &self,
        level: LogLevel,
        message: &str,
        meta: Option<&Value>,
    ) -> Result<(), RpcError> {
        let mut params = vec![serde_json::to_value(level)?, json!(message)];
        if let Some(meta) = meta {
            params.push(meta.clone());
        }
        self.call_unit("log", params)
    }

    // -- Workspaces ---------------------------------------------------------

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, RpcError> {
        self.call_as("listWorkspaces", vec![])
    }

    pub fn create_workspace(&self, input: &CreateWorkspaceInput) -> Result<Workspace, RpcError> {
        self.call_as("createWorkspace", vec![serde_json::to_value(input)?])
    }

    pub fn create_scratch_workspace(&self) -> Result<Workspace, RpcError> {
        self.call_as("createScratchWorkspace", vec![])
    }

    pub fn create_orchestrator_workspace(&self) -> Result<Workspace, RpcError> {
        self.call_as("createOrchestratorWorkspace", vec![])
    }

    pub fn archive_workspace(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("archiveWorkspace", vec![json!(id)])
    }

    pub fn unarchive_workspace(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("unarchiveWorkspace", vec![json!(id)])
    }

    pub fn delete_workspace(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("deleteWorkspace", vec![json!(id)])
    }

    pub fn delete_workspaces(&self, ids: &[String]) -> Result<(), RpcError> {
        self.call_unit("deleteWorkspaces", vec![json!(ids)])
    }

    pub fn import_to_sandbox(&self, id: &str, endpoint: &str) -> Result<Workspace, RpcError> {
        self.call_as("importToSandbox", vec![json!(id), json!(endpoint)])
    }

    pub fn eject_from_sandbox(&self, id: &str) -> Result<Workspace, RpcError> {
        self.call_as("ejectFromSandbox", vec![json!(id)])
    }

    /// Returns the snapshot path.
    pub fn backup_sandbox(&self, id: &str) -> Result<String, RpcError> {
        self.call_as("backupSandbox", vec![json!(id)])
    }

    pub fn mark_seen(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("markSeen", vec![json!(id)])
    }

    pub fn set_unread(&self, id: &str, unread: bool) -> Result<(), RpcError> {
        self.call_unit("setUnread", vec![json!(id), json!(unread)])
    }

    pub fn rename_branch(&self, id: &str, new_branch: &str) -> Result<Workspace, RpcError> {
        self.call_as("renameBranch", vec![json!(id), json!(new_branch)])
    }

    pub fn reorder_workspaces(&self, ordered_ids: &[String]) -> Result<(), RpcError> {
        self.call_unit("reorderWorkspaces", vec![json!(ordered_ids)])
    }

    // -- Prompt queue -------------------------------------------------------

    pub fn queue_prompt(&self, id: &str, text: &str) -> Result<Workspace, RpcError> {
        self.call_as("queuePrompt", vec![json!(id), json!(text)])
    }

    pub fn remove_queued_prompt(&self, id: &str, prompt_id: &str) -> Result<Workspace, RpcError> {
        self.call_as("removeQueuedPrompt", vec![json!(id), json!(prompt_id)])
    }

    pub fn flush_queued_prompts(&self, id: &str) -> Result<FlushQueuedPromptsResult, RpcError> {
        self.call_as("flushQueuedPrompts", vec![json!(id)])
    }

    // -- Terminal (pty) -----------------------------------------------------

    pub fn pty_start(&self, id: &str, cols: u16, rows: u16) -> Result<(), RpcError> {
        self.call_unit("ptyStart", vec![json!(id), json!(cols), json!(rows)])
    }

    /// The JSON `pty:write` method. Prefer [`RpcClient::send_pty_write`] (the
    /// binary fast path) for keystroke traffic.
    pub fn pty_write(&self, id: &str, data: &str) -> Result<(), RpcError> {
        self.call_unit("ptyWrite", vec![json!(id), json!(data)])
    }

    pub fn pty_resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), RpcError> {
        self.call_unit("ptyResize", vec![json!(id), json!(cols), json!(rows)])
    }

    /// SIGWINCH repaint bounce — heals diff-render desync.
    pub fn pty_repaint(&self, id: &str, cols: u16, rows: u16) -> Result<(), RpcError> {
        self.call_unit("ptyRepaint", vec![json!(id), json!(cols), json!(rows)])
    }

    /// Scrollback replay for a PTY (M1-added `pty:scrollback`, protocol §6).
    /// The wire result is base64; this returns the raw bytes to feed the
    /// terminal.
    pub fn pty_scrollback(&self, id: &str) -> Result<Vec<u8>, RpcError> {
        let b64: String = self.call_as("pty:scrollback", vec![json!(id)])?;
        base64::decode(&b64)
            .ok_or_else(|| RpcError::BadPayload("pty:scrollback returned invalid base64".into()))
    }

    /// `bytes` travel base64-encoded in the JSON `req` (protocol §4; the
    /// ≤16 MiB frame cap applies). Returns the temp-file path, or None for
    /// empty input.
    pub fn save_clipboard_image(
        &self,
        mime: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, RpcError> {
        self.call_as(
            "saveClipboardImage",
            vec![json!(mime), json!(base64::encode(bytes))],
        )
    }

    pub fn restart_agent(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("restartAgent", vec![json!(id)])
    }

    pub fn stop_agent(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("stopAgent", vec![json!(id)])
    }

    pub fn nvim_start(&self, id: &str, cols: u16, rows: u16) -> Result<(), RpcError> {
        self.call_unit("nvimStart", vec![json!(id), json!(cols), json!(rows)])
    }

    // -- Sandbox cross-machine ownership ------------------------------------

    pub fn sandbox_control_state(&self, id: &str) -> Result<Option<SandboxControlState>, RpcError> {
        self.call_as("sandboxControlState", vec![json!(id)])
    }

    pub fn take_sandbox_control(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("takeSandboxControl", vec![json!(id)])
    }

    // -- Git / Diff ---------------------------------------------------------

    pub fn get_diff(&self, id: &str) -> Result<Vec<DiffFile>, RpcError> {
        self.call_as("getDiff", vec![json!(id)])
    }

    pub fn get_diff_stats(&self, id: &str) -> Result<DiffStats, RpcError> {
        self.call_as("getDiffStats", vec![json!(id)])
    }

    pub fn get_worktree_sizes(&self) -> Result<WorktreeSizes, RpcError> {
        self.call_as("getWorktreeSizes", vec![])
    }

    pub fn sample_resources(&self) -> Result<ResourceSnapshot, RpcError> {
        self.call_as("sampleResources", vec![])
    }

    pub fn find_pr(&self, id: &str) -> Result<PrsForBranch, RpcError> {
        self.call_as("findPR", vec![json!(id)])
    }

    pub fn verify_linear(&self, id: &str) -> Result<Option<LinearIssue>, RpcError> {
        self.call_as("verifyLinear", vec![json!(id)])
    }

    pub fn list_branches(&self, id: &str) -> Result<Vec<String>, RpcError> {
        self.call_as("listBranches", vec![json!(id)])
    }

    pub fn switch_branch(&self, id: &str, branch: &str) -> Result<Workspace, RpcError> {
        self.call_as("switchBranch", vec![json!(id), json!(branch)])
    }

    pub fn merge_worktree(&self, id: &str) -> Result<MergeWorktreeResult, RpcError> {
        self.call_as("mergeWorktree", vec![json!(id)])
    }

    // -- Repo scripts -------------------------------------------------------

    pub fn get_repo_scripts(&self, repo_path: &str) -> Result<RepoScripts, RpcError> {
        self.call_as("getRepoScripts", vec![json!(repo_path)])
    }

    pub fn set_repo_scripts(
        &self,
        repo_path: &str,
        scripts: &RepoScripts,
    ) -> Result<RepoEntry, RpcError> {
        self.call_as(
            "setRepoScripts",
            vec![json!(repo_path), serde_json::to_value(scripts)?],
        )
    }

    pub fn retry_setup(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("retrySetup", vec![json!(id)])
    }

    pub fn read_setup_log(&self, id: &str) -> Result<String, RpcError> {
        self.call_as("readSetupLog", vec![json!(id)])
    }

    pub fn run_script_start(&self, id: &str, cols: u16, rows: u16) -> Result<(), RpcError> {
        self.call_unit("runScriptStart", vec![json!(id), json!(cols), json!(rows)])
    }

    pub fn run_script_stop(&self, id: &str) -> Result<(), RpcError> {
        self.call_unit("runScriptStop", vec![json!(id)])
    }

    pub fn run_script_scrollback(&self, id: &str) -> Result<String, RpcError> {
        self.call_as("runScriptScrollback", vec![json!(id)])
    }

    pub fn run_script_status(&self, id: &str) -> Result<bool, RpcError> {
        self.call_as("runScriptStatus", vec![json!(id)])
    }

    // -- Insights & Improvements (self-tune) --------------------------------

    pub fn list_self_tune_runs(&self) -> Result<Vec<SelfTuneRun>, RpcError> {
        self.call_as("listSelfTuneRuns", vec![])
    }

    pub fn start_self_tune(&self) -> Result<SelfTuneRun, RpcError> {
        self.call_as("startSelfTune", vec![])
    }

    pub fn get_self_tune_output(&self, run_id: &str) -> Result<String, RpcError> {
        self.call_as("getSelfTuneOutput", vec![json!(run_id)])
    }

    pub fn list_self_tune_reports(&self) -> Result<Vec<SelfTuneReport>, RpcError> {
        self.call_as("listSelfTuneReports", vec![])
    }

    pub fn open_self_tune_report(&self, login_id: &str) -> Result<bool, RpcError> {
        self.call_as("openSelfTuneReport", vec![json!(login_id)])
    }

    pub fn read_self_tune_lessons(&self) -> Result<String, RpcError> {
        self.call_as("readSelfTuneLessons", vec![])
    }

    // -- M1 protocol additions (docs/ui-rpc-protocol.md §4) -----------------

    pub fn deps_status(&self) -> Result<DepsStatus, RpcError> {
        self.call_as("deps:status", vec![])
    }

    pub fn app_info(&self) -> Result<AppInfo, RpcError> {
        self.call_as("app:info", vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule_matches_reconnect_policy_ts() {
        let p = BackoffPolicy::default();
        let delays: Vec<u64> = (0..7).map(|a| p.delay_ms(a)).collect();
        assert_eq!(
            delays,
            vec![1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
        );
        assert!(!p.should_give_up(180_000));
        assert!(p.should_give_up(180_001));
    }
}
