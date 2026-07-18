//! Length-prefixed frame codec (docs/ui-rpc-protocol.md §2).
//!
//! `[u32 BE length][payload]`, payload discriminated by first byte:
//! `{` = JSON frame; 0x01 = ptyData (S→C); 0x02 = ptyWrite (C→S).

use serde_json::Value;

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

const PTY_DATA: u8 = 0x01;
const PTY_WRITE: u8 = 0x02;

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// Any JSON frame (`hello`, `req`, `res`, `event`, `focus`, `ping`, …).
    /// Typed decoding happens one layer up; the codec stays shape-agnostic.
    Json(Value),
    PtyData {
        id: String,
        bytes: Vec<u8>,
    },
    PtyWrite {
        id: String,
        bytes: Vec<u8>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame exceeds {MAX_FRAME_BYTES} bytes: {0}")]
    TooLarge(usize),
    #[error("empty frame")]
    Empty,
    #[error("malformed binary frame")]
    MalformedBinary,
    #[error("invalid UTF-8 in pty id")]
    BadId,
    #[error("invalid JSON payload: {0}")]
    BadJson(#[from] serde_json::Error),
    #[error("unknown payload discriminant {0:#04x}")]
    UnknownDiscriminant(u8),
}

pub fn encode(frame: &Frame) -> Result<Vec<u8>, FrameError> {
    let payload = match frame {
        Frame::Json(v) => serde_json::to_vec(v)?,
        Frame::PtyData { id, bytes } => encode_binary(PTY_DATA, id, bytes),
        Frame::PtyWrite { id, bytes } => encode_binary(PTY_WRITE, id, bytes),
    };
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(payload.len()));
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

fn encode_binary(tag: u8, id: &str, bytes: &[u8]) -> Vec<u8> {
    let idb = id.as_bytes();
    let mut p = Vec::with_capacity(1 + 4 + idb.len() + bytes.len());
    p.push(tag);
    p.extend_from_slice(&(idb.len() as u32).to_be_bytes());
    p.extend_from_slice(idb);
    p.extend_from_slice(bytes);
    p
}

fn decode_payload(payload: &[u8]) -> Result<Frame, FrameError> {
    match *payload.first().ok_or(FrameError::Empty)? {
        b'{' => Ok(Frame::Json(serde_json::from_slice(payload)?)),
        tag @ (PTY_DATA | PTY_WRITE) => {
            if payload.len() < 5 {
                return Err(FrameError::MalformedBinary);
            }
            let id_len = u32::from_be_bytes(payload[1..5].try_into().unwrap()) as usize;
            let body = &payload[5..];
            if body.len() < id_len {
                return Err(FrameError::MalformedBinary);
            }
            let id = std::str::from_utf8(&body[..id_len])
                .map_err(|_| FrameError::BadId)?
                .to_string();
            let bytes = body[id_len..].to_vec();
            Ok(match tag {
                PTY_DATA => Frame::PtyData { id, bytes },
                _ => Frame::PtyWrite { id, bytes },
            })
        }
        other => Err(FrameError::UnknownDiscriminant(other)),
    }
}

/// Streaming decoder: feed arbitrary chunks, pull complete frames.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes(self.buf[..4].try_into().unwrap()) as usize;
        if len > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge(len));
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        let payload: Vec<u8> = self.buf.drain(..4 + len).skip(4).collect();
        decode_payload(&payload).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roundtrip(f: Frame) {
        let enc = encode(&f).unwrap();
        let mut d = Decoder::new();
        d.feed(&enc);
        assert_eq!(d.next_frame().unwrap().unwrap(), f);
        assert!(d.next_frame().unwrap().is_none());
    }

    #[test]
    fn json_roundtrip() {
        roundtrip(Frame::Json(
            json!({"t":"req","id":1,"method":"listWorkspaces","params":[]}),
        ));
    }

    #[test]
    fn pty_frames_roundtrip() {
        roundtrip(Frame::PtyData {
            id: "ws-1".into(),
            bytes: vec![0, 159, 146, 150],
        });
        roundtrip(Frame::PtyWrite {
            id: "ws-1:run".into(),
            bytes: b"ls\r".to_vec(),
        });
    }

    #[test]
    fn split_delivery() {
        let enc = encode(&Frame::Json(json!({"t":"ping"}))).unwrap();
        let mut d = Decoder::new();
        for b in &enc[..enc.len() - 1] {
            d.feed(std::slice::from_ref(b));
            assert!(d.next_frame().unwrap().is_none());
        }
        d.feed(&enc[enc.len() - 1..]);
        assert!(d.next_frame().unwrap().is_some());
    }

    #[test]
    fn back_to_back_frames() {
        let mut both = encode(&Frame::Json(json!({"t":"ping"}))).unwrap();
        both.extend(
            encode(&Frame::PtyData {
                id: "a".into(),
                bytes: vec![1],
            })
            .unwrap(),
        );
        let mut d = Decoder::new();
        d.feed(&both);
        assert!(matches!(d.next_frame().unwrap().unwrap(), Frame::Json(_)));
        assert!(matches!(
            d.next_frame().unwrap().unwrap(),
            Frame::PtyData { .. }
        ));
    }

    #[test]
    fn oversize_rejected() {
        let mut d = Decoder::new();
        d.feed(&(MAX_FRAME_BYTES as u32 + 1).to_be_bytes());
        d.feed(b"x");
        assert!(matches!(d.next_frame(), Err(FrameError::TooLarge(_))));
    }
}
