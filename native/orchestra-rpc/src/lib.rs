//! UI-RPC protocol client for Orchestra backends.
//!
//! Contract: docs/ui-rpc-protocol.md (frozen v1). The method set mirrors
//! `src/shared/ipc.ts` (`OrchestraAPI`); the wire types mirror
//! `src/shared/types.ts` and friends. Conformance fixtures live in
//! `fixtures/` and are the drift gate — see the plan §2.
//!
//! Layers, bottom-up:
//! - [`frame`] — length-prefixed codec (JSON + binary PTY frames);
//! - [`protocol`] — the `t`-tagged JSON frame vocabulary + handshake types;
//! - [`types`] — serde mirrors of every wire shape;
//! - [`events`] — the event channels and their typed decoding;
//! - [`client`] — the blocking [`client::RpcClient`] (reader thread,
//!   ping/pong, reconnect-with-backoff, typed method wrappers).

mod base64;
pub mod client;
pub mod events;
pub mod frame;
pub mod protocol;
pub mod types;

pub use client::{
    discover_socket_path, BackoffPolicy, ClientOptions, ConnectionState, Receivers, RpcClient,
    RpcError, ServerInfo,
};
pub use events::{Event, UiEvent};
pub use protocol::{BackendKind, ClientKind, PROTO_VERSION};
