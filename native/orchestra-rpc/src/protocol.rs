//! Typed JSON frames of the UI-RPC protocol (docs/ui-rpc-protocol.md §3).
//!
//! The frame codec (`crate::frame`) stays shape-agnostic; this layer gives the
//! JSON frames their `t`-tagged types. Unknown `t` values are tolerated one
//! layer up (the client ignores them) so a newer backend can add frames.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The protocol revision this crate speaks.
pub const PROTO_VERSION: u32 = 1;

/// `hello.clientKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientKind {
    Gtk,
    Electron,
    Test,
}

/// `helloOk.backendKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Electron,
    Daemon,
}

/// The `error` object of a failed `res` frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResError {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Every JSON frame the protocol defines, tagged by `t`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum JsonFrame {
    #[serde(rename_all = "camelCase")]
    Hello {
        proto: u32,
        app_version: String,
        client_kind: ClientKind,
        focused: bool,
    },
    #[serde(rename_all = "camelCase")]
    HelloOk {
        proto: u32,
        app_version: String,
        backend_kind: BackendKind,
    },
    Req {
        id: u32,
        method: String,
        params: Vec<Value>,
    },
    Res {
        id: u32,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ResError>,
    },
    Event {
        channel: String,
        args: Vec<Value>,
    },
    Focus {
        focused: bool,
    },
    Ping,
    Pong,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_carry_their_t_tag() {
        assert_eq!(
            serde_json::to_value(JsonFrame::Ping).unwrap(),
            json!({"t":"ping"})
        );
        let hello = JsonFrame::Hello {
            proto: 1,
            app_version: "0.5.84".into(),
            client_kind: ClientKind::Gtk,
            focused: true,
        };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            json!({"t":"hello","proto":1,"appVersion":"0.5.84","clientKind":"gtk","focused":true})
        );
    }

    #[test]
    fn res_frames_roundtrip_both_arms() {
        let ok: JsonFrame =
            serde_json::from_value(json!({"t":"res","id":3,"ok":true,"result":[1,2]})).unwrap();
        assert!(matches!(ok, JsonFrame::Res { ok: true, .. }));
        let err: JsonFrame = serde_json::from_value(
            json!({"t":"res","id":4,"ok":false,"error":{"message":"boom","name":"Error"}}),
        )
        .unwrap();
        match err {
            JsonFrame::Res {
                ok: false,
                error: Some(e),
                ..
            } => assert_eq!(e.message, "boom"),
            other => panic!("unexpected: {other:?}"),
        }
    }
}
