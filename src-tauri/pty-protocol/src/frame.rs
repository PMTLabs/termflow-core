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

/// Authenticated origin of an armed detach hold. `None` is intentionally the
/// legacy/unlabelled meaning: an indefinite hold. The host records this now;
/// enforcement is a later lifecycle change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArmDetachPurpose {
    /// This GUI explicitly offloaded itself or is applying its own update.
    Local,
}

/// GUI → sidecar requests. Every request that expects a reply carries a `req`
/// id the sidecar echoes in its [`Response`], so the GUI can demultiplex
/// replies from the shared inbound stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Control {
    Spawn { req: u64, tab_id: String, spec: SpawnSpec },
    Resize { tab_id: String, cols: u16, rows: u16 },
    Close { tab_id: String },
    ListSessions {
        req: u64,
        /// Credentials for a reconnect lifecycle probe.  Older clients omit
        /// this and retain their legacy, non-adopting behavior.
        #[serde(default)]
        token: Option<String>,
    },
    /// Reattach `tab_id`, replaying buffered output from `from_offset`.
    Attach { req: u64, tab_id: String, from_offset: u64 },
    /// Arm hot-swap hold. `token` must match the sidecar's launch token.
    ArmDetach {
        req: u64,
        timeout_secs: u64,
        token: String,
        /// Trailing/defaulted for old clients that encoded this variant before
        /// purposes existed. No purpose retains today's indefinite semantics.
        #[serde(default)]
        purpose: Option<ArmDetachPurpose>,
    },
    Disarm { req: u64 },
    /// RP-3: like [`Control::Attach`] but the host confirms with
    /// [`Response::AttachAck`], so a reattaching GUI can verify each session was
    /// actually re-wired instead of assuming. COMPATIBILITY: send ONLY to a host
    /// whose discovery record advertises `CAP_ATTACH_ACK` — a legacy host fails
    /// to decode this variant and drops the connection. (Kept as a trailing
    /// additive variant so all shipped variant indices are unchanged.)
    AttachAcked { req: u64, tab_id: String, from_offset: u64 },
    /// The GUI is exiting ON PURPOSE and wants every hosted session torn down.
    /// A host advertising `CAP_SHUTDOWN_CONTROL` no longer treats a bare pipe
    /// drop as a quit — a GUI that crashes looks identical on the wire to one
    /// that quit, so the host HOLDS its live children (bounded) for a relaunch
    /// to adopt. This frame is what distinguishes "Exit" from "died": the host
    /// acks, then tears down on the disconnect that follows. `token` must match
    /// the host's launch token. COMPATIBILITY: a legacy host fails to decode
    /// this variant and drops the connection — which for it IS teardown — but
    /// send it only when the capability was advertised so the ack wait is never
    /// spent on a host that will not answer.
    Shutdown { req: u64, token: String },
    /// Hold this MCP port during the coming absence. Valid only while a Local
    /// ArmDetach is in force; the holder starts when the GUI is gone.
    /// COMPATIBILITY: send ONLY to a host whose discovery record advertises
    /// `CAP_MCP_HOLD` — a legacy host fails to decode this variant and drops the
    /// connection. (Trailing additive variant; shipped indices are unchanged.)
    HoldMcp { req: u64, token: String, spec: McpHoldSpec },
    /// A relaunched GUI adopting this host and announcing it will take the MCP
    /// port back. An authenticated lifecycle frame: it adopts like
    /// `ListSessions`, but a running holder keeps serving until `ReleaseMcp` or
    /// its grace ends. Same `CAP_MCP_HOLD` gate as [`Control::HoldMcp`].
    ClaimMcp { req: u64, token: String },
    /// Stop holding. Acked at once; the holder closes within its stop bound.
    /// Same `CAP_MCP_HOLD` gate as [`Control::HoldMcp`].
    ReleaseMcp { req: u64, token: String },
    /// Send only when CAP_PERMISSIONS was advertised.
    PermissionStatus { req: u64, token: String },
    RequestPermission { req: u64, token: String, kind: PermissionKind },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PermissionKind { Accessibility, ScreenRecording }

/// `Unknown` reports an indeterminate result (for example a child timeout),
/// distinct from the platform explicitly reporting `Unsupported`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionState { Granted, NotGranted, Unsupported, Unknown }

/// Why the GUI asked the host to hold its MCP port; selects the wording of the
/// message the holder serves to agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpHoldReason {
    Offload,
    OffloadUpdate,
    Relaunch,
}

/// Everything the host needs to stand in for the MCP sidecar while the GUI is
/// away. The two snapshot results travel as raw JSON strings so the wire types
/// need no JSON value type and the host serves the bytes it was handed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpHoldSpec {
    /// The effective port the sidecar listened on.
    pub port: u16,
    /// The network config's port at offload (provenance).
    pub configured_port: u16,
    /// The sidecar's `MCP_HOST`: an IP literal, never a name.
    pub bind_host: String,
    /// The sidecar's bearer token; `None` or empty means open.
    pub auth_token: Option<String>,
    pub reason: McpHoldReason,
    /// Raw JSON `result` of the sidecar's `initialize`.
    pub initialize_result: Option<String>,
    /// Raw JSON `result` of the sidecar's `tools/list`.
    pub tools_list_result: Option<String>,
}

/// What a host reports it is holding, in reply to [`Control::ClaimMcp`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpHeld {
    pub port: u16,
    pub configured_port: u16,
    pub bind_host: String,
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
    /// RP-3: reply to [`Control::AttachAcked`] ONLY (never to plain `Attach` —
    /// a legacy client fails to decode this variant). `alive:false` means the
    /// tab was unknown or its child already exited; `tail_offset` is the ring's
    /// next-write offset at ack time.
    AttachAck { req: u64, tab_id: String, alive: bool, tail_offset: u64 },
    /// Reply to [`Control::Shutdown`]: the host has latched teardown and will
    /// kill every session as soon as this connection closes.
    ShutdownAck { req: u64 },
    /// Reply to [`Control::HoldMcp`] ONLY, and only from a host advertising
    /// `CAP_MCP_HOLD`. `reason` explains a rejection.
    McpHoldAck { req: u64, accepted: bool, reason: Option<String> },
    /// Reply to [`Control::ClaimMcp`]: what the host is holding, if anything.
    McpClaimAck { req: u64, held: Option<McpHeld> },
    /// Reply to [`Control::ReleaseMcp`]: stop has been ORDERED (not completed).
    McpReleaseAck { req: u64, was_holding: bool },
    PermissionStatusReply { req: u64, accessibility: PermissionState, screen_recording: PermissionState },
    PermissionRequested { req: u64, kind: PermissionKind, state: PermissionState },
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
    bincode::deserialize(payload)
        .or_else(|current| {
            // Bincode does not honor a trailing serde default when the old
            // tuple-variant payload ends at EOF. Fall back to the exact
            // pre-purpose wire shape so already-shipped ArmDetach frames keep
            // their unlabelled/indefinite meaning.
            bincode::deserialize::<LegacyFrame>(payload)
                .map(Into::into)
                .map_err(|_| current)
        })
        .map_err(|e| DecodeError(e.to_string()))
}

/// Exact pre-purpose frame layout, retained solely for decoding old clients.
/// Keep variant order synchronized with the originally shipped protocol.
#[derive(Deserialize)]
enum LegacyControl {
    Spawn { req: u64, tab_id: String, spec: SpawnSpec },
    Resize { tab_id: String, cols: u16, rows: u16 },
    Close { tab_id: String },
    ListSessions { req: u64 },
    Attach { req: u64, tab_id: String, from_offset: u64 },
    ArmDetach { req: u64, timeout_secs: u64, token: String },
    Disarm { req: u64 },
    AttachAcked { req: u64, tab_id: String, from_offset: u64 },
}

#[derive(Deserialize)]
enum LegacyFrame {
    Ctrl(LegacyControl),
    Resp(Response),
    Data(Data),
}

impl From<LegacyFrame> for Frame {
    fn from(value: LegacyFrame) -> Self {
        match value {
            LegacyFrame::Ctrl(ctrl) => Frame::Ctrl(match ctrl {
                LegacyControl::Spawn { req, tab_id, spec } => Control::Spawn { req, tab_id, spec },
                LegacyControl::Resize { tab_id, cols, rows } => Control::Resize { tab_id, cols, rows },
                LegacyControl::Close { tab_id } => Control::Close { tab_id },
                LegacyControl::ListSessions { req } => Control::ListSessions { req, token: None },
                LegacyControl::Attach { req, tab_id, from_offset } => Control::Attach { req, tab_id, from_offset },
                LegacyControl::ArmDetach { req, timeout_secs, token } => Control::ArmDetach {
                    req, timeout_secs, token, purpose: None,
                },
                LegacyControl::Disarm { req } => Control::Disarm { req },
                LegacyControl::AttachAcked { req, tab_id, from_offset } => Control::AttachAcked { req, tab_id, from_offset },
            }),
            LegacyFrame::Resp(response) => Frame::Resp(response),
            LegacyFrame::Data(data) => Frame::Data(data),
        }
    }
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

    /// `Shutdown` / `ShutdownAck` are TRAILING variants: every index a shipped
    /// peer already relies on must stay where it is. Pinned by roundtripping
    /// the new frames AND by re-checking that a pre-existing variant still
    /// decodes from its original wire index (the legacy-shape test below).
    #[test]
    fn shutdown_frames_roundtrip() {
        for frame in [
            Frame::Ctrl(Control::Shutdown {
                req: 11,
                token: "token".into(),
            }),
            Frame::Resp(Response::ShutdownAck { req: 11 }),
        ] {
            let encoded = encode(&frame);
            assert_eq!(decode(encoded[0], &encoded[5..]).unwrap(), frame);
        }
    }

    fn mcp_roundtrip(frame: Frame) {
        let encoded = encode(&frame);
        assert_eq!(decode(encoded[0], &encoded[5..]).unwrap(), frame);
    }

    /// Every new MCP-hold frame, with non-default values in every field, is
    /// encoded, decoded and compared (`==`) with an independently built value.
    #[test]
    fn mcp_hold_frames_roundtrip() {
        let initialize = "{ \"protocolVersion\":\"2025-03-26\" ,\"capabilities\":{\"tools\":{ }},\n\t\"serverInfo\":{\"name\":\"\u{e9}x\\u00e9\"} }";
        let tools = "{\"tools\":[ {\"name\":\"b\",\"inputSchema\":{}} ,\n{\"name\":\"a\"}],  \"z\":null}";

        // HoldMcp: IPv6 host, port != configured_port, each reason, snapshots
        // both present (unusual JSON) and absent, token present / empty / absent.
        let hold = |req, token: &str, spec| Frame::Ctrl(Control::HoldMcp { req, token: token.into(), spec });
        let full = hold(
            7,
            "launch-token",
            McpHoldSpec {
                port: 40123,
                configured_port: 40120,
                bind_host: "::1".into(),
                auth_token: Some("bearer-secret".into()),
                reason: McpHoldReason::Offload,
                initialize_result: Some(initialize.into()),
                tools_list_result: Some(tools.into()),
            },
        );
        let update_open = hold(
            7,
            "launch-token",
            McpHoldSpec {
                port: 65535,
                configured_port: 1,
                bind_host: "fe80::1ff:fe23:4567:890a".into(),
                auth_token: None,
                reason: McpHoldReason::OffloadUpdate,
                initialize_result: None,
                tools_list_result: Some(tools.into()),
            },
        );
        let relaunch_empty_token = hold(
            7,
            "launch-token",
            McpHoldSpec {
                port: 42190,
                configured_port: 42191,
                bind_host: "0.0.0.0".into(),
                auth_token: Some(String::new()),
                reason: McpHoldReason::Relaunch,
                initialize_result: Some(initialize.into()),
                tools_list_result: None,
            },
        );
        for frame in [full.clone(), update_open, relaunch_empty_token] {
            mcp_roundtrip(frame);
        }
        // The decoded value is the independently built one, field by field.
        let encoded = encode(&full);
        match decode(encoded[0], &encoded[5..]).unwrap() {
            Frame::Ctrl(Control::HoldMcp { req, token, spec }) => {
                assert_eq!(req, 7);
                assert_eq!(token, "launch-token");
                assert_eq!(spec.port, 40123);
                assert_eq!(spec.configured_port, 40120);
                assert_eq!(spec.bind_host, "::1");
                assert_eq!(spec.auth_token.as_deref(), Some("bearer-secret"));
                assert_eq!(spec.reason, McpHoldReason::Offload);
                assert_eq!(spec.initialize_result.as_deref(), Some(initialize));
                assert_eq!(spec.tools_list_result.as_deref(), Some(tools));
            }
            other => panic!("decoded to the wrong variant: {other:?}"),
        }

        mcp_roundtrip(Frame::Ctrl(Control::ClaimMcp { req: 8, token: "launch-token".into() }));
        mcp_roundtrip(Frame::Ctrl(Control::ReleaseMcp { req: 9, token: "launch-token".into() }));

        mcp_roundtrip(Frame::Resp(Response::McpHoldAck { req: 7, accepted: true, reason: None }));
        mcp_roundtrip(Frame::Resp(Response::McpHoldAck {
            req: 7,
            accepted: false,
            reason: Some("already holding".into()),
        }));
        mcp_roundtrip(Frame::Resp(Response::McpClaimAck {
            req: 8,
            held: Some(McpHeld { port: 40123, configured_port: 40120, bind_host: "::1".into() }),
        }));
        mcp_roundtrip(Frame::Resp(Response::McpClaimAck { req: 8, held: None }));
        mcp_roundtrip(Frame::Resp(Response::McpReleaseAck { req: 9, was_holding: true }));
        mcp_roundtrip(Frame::Resp(Response::McpReleaseAck { req: 9, was_holding: false }));

        // The reply `req` is the request's, not a constant: a different value
        // must survive too.
        let encoded = encode(&Frame::Resp(Response::McpReleaseAck { req: 0x0102_0304_0506_0708, was_holding: true }));
        assert_eq!(
            decode(encoded[0], &encoded[5..]).unwrap(),
            Frame::Resp(Response::McpReleaseAck { req: 0x0102_0304_0506_0708, was_holding: true })
        );
    }

    /// First 8 payload bytes: the `Frame` variant index then the inner enum's
    /// variant index, each a bincode `u32` LE.
    fn tags(frame: &Frame) -> (u32, u32) {
        let encoded = encode(frame);
        let p = &encoded[5..];
        (
            u32::from_le_bytes(p[0..4].try_into().unwrap()),
            u32::from_le_bytes(p[4..8].try_into().unwrap()),
        )
    }

    /// The error serde raises for a variant index past the last variant names
    /// the variant COUNT, so this pins "exactly N variants" without a derive.
    fn variant_count_error(frame_tag: u32, inner_tag: u32) -> String {
        let mut payload = Vec::new();
        payload.extend_from_slice(&frame_tag.to_le_bytes());
        payload.extend_from_slice(&inner_tag.to_le_bytes());
        bincode::deserialize::<Frame>(&payload).unwrap_err().to_string()
    }

    /// Every shipped wire tag is pinned, and the three MCP variants of each of
    /// `Control` and `Response` are the LAST three (trailing, additive).
    #[test]
    fn existing_variant_indices_unchanged() {
        let spec = || SpawnSpec {
            shell: "sh".into(),
            args: vec![],
            env: vec![],
            env_remove: vec![],
            cwd: None,
            cols: 80,
            rows: 24,
            initial_cursor_row: None,
        };
        let hold_spec = McpHoldSpec {
            port: 1,
            configured_port: 2,
            bind_host: "127.0.0.1".into(),
            auth_token: None,
            reason: McpHoldReason::Offload,
            initialize_result: None,
            tools_list_result: None,
        };
        let t = || "t".to_string();
        let ctrl: Vec<(Control, u32)> = vec![
            (Control::Spawn { req: 1, tab_id: t(), spec: spec() }, 0),
            (Control::Resize { tab_id: t(), cols: 1, rows: 1 }, 1),
            (Control::Close { tab_id: t() }, 2),
            (Control::ListSessions { req: 1, token: None }, 3),
            (Control::Attach { req: 1, tab_id: t(), from_offset: 0 }, 4),
            (Control::ArmDetach { req: 1, timeout_secs: 1, token: t(), purpose: None }, 5),
            (Control::Disarm { req: 1 }, 6),
            (Control::AttachAcked { req: 1, tab_id: t(), from_offset: 0 }, 7),
            (Control::Shutdown { req: 1, token: t() }, 8),
            (Control::HoldMcp { req: 1, token: t(), spec: hold_spec }, 9),
            (Control::ClaimMcp { req: 1, token: t() }, 10),
            (Control::ReleaseMcp { req: 1, token: t() }, 11),
        ];
        for (control, index) in ctrl {
            assert_eq!(tags(&Frame::Ctrl(control.clone())), (0, index), "{control:?}");
        }
        let resp: Vec<(Response, u32)> = vec![
            (Response::Spawned { req: 1, tab_id: t(), pid: 1 }, 0),
            (Response::SpawnFailed { req: 1, tab_id: t(), error: t() }, 1),
            (Response::SessionList { req: 1, sessions: vec![] }, 2),
            (Response::ArmAck { req: 1, deadline_ms: 1 }, 3),
            (Response::DisarmAck { req: 1 }, 4),
            (Response::AttachAck { req: 1, tab_id: t(), alive: true, tail_offset: 0 }, 5),
            (Response::ShutdownAck { req: 1 }, 6),
            (Response::McpHoldAck { req: 1, accepted: true, reason: None }, 7),
            (Response::McpClaimAck { req: 1, held: None }, 8),
            (Response::McpReleaseAck { req: 1, was_holding: true }, 9),
        ];
        for (response, index) in resp {
            assert_eq!(tags(&Frame::Resp(response.clone())), (1, index), "{response:?}");
        }
        let data: Vec<(Data, u32)> = vec![
            (Data::Stdin { tab_id: t(), bytes: vec![] }, 0),
            (Data::Stdout { tab_id: t(), offset: 0, bytes: vec![] }, 1),
            (Data::Gap { tab_id: t(), at_offset: 0 }, 2),
            (Data::Exit { tab_id: t(), exit_cwd: None }, 3),
        ];
        for (d, index) in data {
            assert_eq!(tags(&Frame::Data(d.clone())), (2, index), "{d:?}");
        }

        // Additive permission variants occupy indices 12–13 and 10–11.
        assert!(variant_count_error(0, 14).contains("0 <= i < 14"), "{}", variant_count_error(0, 14));
        assert!(variant_count_error(1, 12).contains("0 <= i < 12"), "{}", variant_count_error(1, 12));
        assert!(variant_count_error(2, 4).contains("0 <= i < 4"), "{}", variant_count_error(2, 4));
        assert!(variant_count_error(3, 0).contains("0 <= i < 3"), "{}", variant_count_error(3, 0));

        // Exact wire bytes of one new reply: Resp tag, McpReleaseAck tag, req, bool.
        let encoded = encode(&Frame::Resp(Response::McpReleaseAck { req: 9, was_holding: true }));
        let mut want = vec![PROTOCOL_VERSION, 17, 0, 0, 0];
        want.extend_from_slice(&1u32.to_le_bytes());
        want.extend_from_slice(&9u32.to_le_bytes());
        want.extend_from_slice(&9u64.to_le_bytes());
        want.push(1);
        assert_eq!(encoded, want);
    }

    #[test]
    fn arm_detach_purpose_roundtrips_in_both_shapes() {
        for purpose in [None, Some(ArmDetachPurpose::Local)] {
            let frame = Frame::Ctrl(Control::ArmDetach {
                req: 7,
                timeout_secs: 600,
                token: "token".into(),
                purpose,
            });
            let encoded = encode(&frame);
            assert_eq!(decode(encoded[0], &encoded[5..]).unwrap(), frame);
        }
    }

    #[test]
    fn old_arm_detach_without_purpose_decodes_as_unlabelled() {
        // This is the pre-purpose bincode layout of the existing ArmDetach
        // variant: Frame::Ctrl index, Control::ArmDetach index, then req,
        // timeout, and token.
        let mut old = Vec::new();
        old.extend_from_slice(&(0u32).to_le_bytes());
        old.extend_from_slice(&(5u32).to_le_bytes());
        old.extend_from_slice(&7u64.to_le_bytes());
        old.extend_from_slice(&600u64.to_le_bytes());
        old.extend_from_slice(&(5u64).to_le_bytes());
        old.extend_from_slice(b"token");
        assert_eq!(
            decode(PROTOCOL_VERSION, &old).unwrap(),
            Frame::Ctrl(Control::ArmDetach {
                req: 7,
                timeout_secs: 600,
                token: "token".into(),
                purpose: None,
            })
        );
    }

    #[test]
    fn a_purposeful_arm_still_decodes_on_a_pre_purpose_host() {
        // The OTHER direction, and the one adopt+warn makes real: a new app is
        // allowed to connect to a stale old host, and then arms it with a
        // purpose that host's decoder has never heard of. The extra Option byte
        // must not desync it — it must read as the unlabelled/indefinite arm.
        let encoded = encode(&Frame::Ctrl(Control::ArmDetach {
            req: 7,
            timeout_secs: 600,
            token: "token".into(),
            purpose: Some(ArmDetachPurpose::Local),
        }));
        let old: LegacyFrame = bincode::deserialize(&encoded[5..])
            .expect("a pre-purpose host must still decode a purposeful arm");
        assert_eq!(
            Frame::from(old),
            Frame::Ctrl(Control::ArmDetach {
                req: 7,
                timeout_secs: 600,
                token: "token".into(),
                purpose: None,
            }),
            "an old host cannot see the purpose, so it must fall back to unlabelled"
        );
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
