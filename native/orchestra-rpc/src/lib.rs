//! UI-RPC protocol client for Orchestra backends.
//!
//! Contract: docs/ui-rpc-protocol.md (frozen v1). The method set mirrors
//! `src/shared/ipc.ts` (`OrchestraAPI`); the wire types mirror
//! `src/shared/types.ts` and friends. Conformance fixtures live in
//! `fixtures/` and are the drift gate — see the plan §2.
//!
//! M0 scaffold: frame codec is implemented and tested; typed API surface and
//! the connection actor are M1/A2 deliverables.

pub mod frame;
pub mod types;
