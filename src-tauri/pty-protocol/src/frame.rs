//! Wire protocol between the GUI and the PTY-host sidecar.
//!
//! Frame layout on the wire: `[version:1][len:4 LE][bincode payload]`.
//! `len` is validated against [`MAX_FRAME_LEN`] BEFORE the payload buffer is
//! allocated, so a malformed/unauthorized peer cannot request a huge alloc.

use crate::spec::SpawnSpec;
use serde::{Deserialize, Serialize};
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Bumped only on a breaking wire change. `decode` rejects any other version.
pub const PROTOCOL_VERSION: u8 = 1;

/// Hard cap on a single frame's payload. 8 MiB comfortably fits the largest
/// replay-ring snapshot (256 KiB) with headroom; anything larger is rejected
/// before allocation.
pub const MAX_FRAME_LEN: usize = 8 * 1024 * 1024;

/// GUI → sidecar requests. Every request that expects a reply carries a `req`
/// id the sidecar echoes in its [`Response`], so the GUI can demultiplex
/// replies from the shared inbound stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Control {
    Spawn { req: u64, tab_id: String, spec: SpawnSpec },
    Resize { tab_id: String, cols: u16, rows: u16 },
    Close { tab_id: String },
    ListSessions { req: u64 },
    /// Reattach `tab_id`, replaying buffered output from `from_offset`.
    Attach { req: u64, tab_id: String, from_offset: u64 },
    /// Arm hot-swap hold. `token` must match the sidecar's launch token.
    ArmDetach { req: u64, timeout_secs: u64, token: String },
    Disarm { req: u64 },
}

/// Sidecar → GUI replies to a `req`-bearing [`Control`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Response {
    Spawned { req: u64, tab_id: String, pid: u32 },
    SpawnFailed { req: u64, tab_id: String, error: String },
    SessionList { req: u64, sessions: Vec<SessionMeta> },
    /// `deadline_ms` is epoch-ms when the hold expires (informational).
    ArmAck { req: u64, deadline_ms: u64 },
    DisarmAck { req: u64 },
}

/// One surviving session as reported by `ListSessions`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    pub tab_id: String,
    /// Child PID, so a reattaching GUI can restore process-derived features
    /// (cwd fallback, foreground-agent detection, metrics) instead of pid 0.
    pub pid: u32,
    /// Oldest byte offset still in the ring (bytes before this were evicted).
    pub head_offset: u64,
    /// Next byte offset to be written (total bytes ever produced).
    pub tail_offset: u64,
    /// False once the child has exited (tombstoned).
    pub alive: bool,
}

/// Unsolicited, event-path frames (not tied to a `req`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Data {
    /// GUI → sidecar keystrokes / API input.
    Stdin { tab_id: String, bytes: Vec<u8> },
    /// Sidecar → GUI output. `offset` is the byte offset of `bytes[0]`.
    Stdout { tab_id: String, offset: u64, bytes: Vec<u8> },
    /// Sidecar → GUI: a discontinuity in the output stream (ring eviction on
    /// reattach, or a dropped live frame under backpressure). Bytes before
    /// `at_offset` may be missing; the GUI should resync from the ring / force a
    /// repaint. This is how the bounded live path stays memory-safe.
    Gap { tab_id: String, at_offset: u64 },
    /// Sidecar → GUI: child exited; `exit_cwd` is its last known directory.
    Exit { tab_id: String, exit_cwd: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Frame {
    Ctrl(Control),
    Resp(Response),
    Data(Data),
}

#[derive(Debug)]
pub struct DecodeError(pub String);

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "frame decode error: {}", self.0)
    }
}
impl std::error::Error for DecodeError {}

/// Encode a frame to `[version][len LE][payload]`.
pub fn encode(frame: &Frame) -> Vec<u8> {
    let payload = bincode::serialize(frame).expect("bincode serialize frame");
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(PROTOCOL_VERSION);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&payload);
    out
}

/// Decode a payload previously produced by [`encode`]. Rejects unknown versions.
pub fn decode(version: u8, payload: &[u8]) -> Result<Frame, DecodeError> {
    if version != PROTOCOL_VERSION {
        return Err(DecodeError(format!("unsupported version {version}")));
    }
    bincode::deserialize(payload).map_err(|e| DecodeError(e.to_string()))
}

/// Read one frame. Returns `Ok(None)` on a clean EOF at a frame boundary.
/// Enforces [`MAX_FRAME_LEN`] BEFORE allocating the payload buffer.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Option<Frame>> {
    let mut ver = [0u8; 1];
    // Clean EOF only if nothing at all is left to read.
    match r.read_exact(&mut ver).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {len} exceeds MAX_FRAME_LEN {MAX_FRAME_LEN}"),
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).await?;
    decode(ver[0], &payload)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.0))
}

/// Write one frame and flush.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, frame: &Frame) -> io::Result<()> {
    w.write_all(&encode(frame)).await?;
    w.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrips_with_version_and_length_prefix() {
        let f = Frame::Data(Data::Stdout {
            tab_id: "tab-1".into(),
            offset: 42,
            bytes: vec![1, 2, 3],
        });
        let buf = encode(&f);
        assert_eq!(buf[0], PROTOCOL_VERSION, "version byte first");
        let len = u32::from_le_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
        assert_eq!(len, buf.len() - 5, "length prefix matches payload");
        let back = decode(buf[0], &buf[5..]).unwrap();
        assert_eq!(back, f);
    }

    #[test]
    fn decode_rejects_unknown_version() {
        let f = Frame::Ctrl(Control::Disarm { req: 1 });
        let buf = encode(&f);
        assert!(decode(99, &buf[5..]).is_err());
    }

    #[tokio::test]
    async fn read_frame_rejects_oversized_len_before_alloc() {
        // Header claims a payload larger than MAX_FRAME_LEN. read_frame must
        // error WITHOUT trying to allocate a buffer of that size.
        let mut buf = Vec::new();
        buf.push(PROTOCOL_VERSION);
        buf.extend_from_slice(&((MAX_FRAME_LEN as u32) + 1).to_le_bytes());
        // No payload bytes follow; the length check must fire first.
        let mut cursor = std::io::Cursor::new(buf);
        let err = read_frame(&mut cursor).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn read_frame_returns_none_on_clean_eof() {
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        assert!(read_frame(&mut cursor).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn write_then_read_roundtrips_over_stream() {
        let f = Frame::Resp(Response::Spawned {
            req: 7,
            tab_id: "t".into(),
            pid: 1234,
        });
        let mut pipe: Vec<u8> = Vec::new();
        write_frame(&mut pipe, &f).await.unwrap();
        let mut cursor = std::io::Cursor::new(pipe);
        let back = read_frame(&mut cursor).await.unwrap().unwrap();
        assert_eq!(back, f);
    }
}
