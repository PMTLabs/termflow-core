//! FROZEN bootstrap handshake — the one part of the wire protocol whose byte
//! layout must NEVER change, so a *new* app and an *old* still-running sidecar
//! can always exchange enough to negotiate a compatible frame codec (or decide
//! to coexist) instead of the frame decoder hard-failing on a version mismatch
//! (design 003 §10.3, review 056 C3).
//!
//! Why a separate, hand-rolled codec instead of `bincode` over an enum: the
//! frame path is `bincode` over evolving Rust enums, so *any* layout change
//! breaks cross-version decode. This envelope is a fixed, self-describing,
//! length-delimited record with an explicit magic and a trailing "extra" region
//! that older parsers ignore — additive fields never break an old reader.
//!
//! Wire layout (all integers little-endian), length-delimited on the stream:
//! ```text
//!   [total_len: u32]            // body length, checked before allocation
//!   -- body --
//!   [magic: 4]  = b"TFPH"       // TermFlow Pty Host; rejects stray bytes
//!   [format: u8] = 1            // envelope format; stays 1 (change ONLY as a last resort)
//!   [kind: u8]                  // 1 = ClientHello, 2 = HostHello
//!   [proto_min: u16]            // lowest frame PROTOCOL_VERSION the peer speaks
//!   [proto_max: u16]            // highest frame PROTOCOL_VERSION the peer speaks
//!   [instance_id: 16]           // u128 host identity (0 from a client)
//!   [capabilities: u32]         // CAP_* bitflags
//!   [session_count: u32]        // live sessions the host currently owns
//!   [build_id_len: u16][build_id: utf8]
//!   [extra ...]                 // IGNORED by this format; reserved for additive fields
//! ```

use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Envelope magic — first 4 body bytes.
pub const MAGIC: [u8; 4] = *b"TFPH";
/// Frozen-envelope format. Bump only if the envelope itself must change (avoid).
pub const BOOTSTRAP_FORMAT: u8 = 1;
/// Lowest / highest frame protocol version this build speaks. Advertised in the
/// hello so a peer can pick a common codec.
pub const PROTOCOL_MIN: u16 = 1;
pub const PROTOCOL_MAX: u16 = 1;
/// Hard cap on a hello body (it is tiny); checked before allocation.
pub const MAX_HELLO_LEN: usize = 64 * 1024;

// Capability bitflags (host → client). Additive; never renumber a shipped bit.
/// Host implements the drain/takeover lifecycle (old host serves its sessions,
/// rejects new spawns, exits when empty). Absent ⇒ legacy host with no drain.
pub const CAP_DRAIN: u32 = 1 << 0;

/// Who is speaking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelloKind {
    Client,
    Host,
}

impl HelloKind {
    fn to_u8(self) -> u8 {
        match self {
            HelloKind::Client => 1,
            HelloKind::Host => 2,
        }
    }
    fn from_u8(b: u8) -> Option<Self> {
        match b {
            1 => Some(HelloKind::Client),
            2 => Some(HelloKind::Host),
            _ => None,
        }
    }
}

/// A decoded bootstrap hello. Construct via [`Hello::client`] / [`Hello::host`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    pub kind: HelloKind,
    pub proto_min: u16,
    pub proto_max: u16,
    /// Host instance identity so a reattaching client can confirm it reconnected
    /// to the SAME host it armed. 0 from a client.
    pub instance_id: u128,
    pub capabilities: u32,
    pub session_count: u32,
    pub build_id: String,
}

impl Hello {
    /// A client hello (this build's protocol range; no instance/sessions).
    pub fn client(build_id: impl Into<String>) -> Self {
        Hello {
            kind: HelloKind::Client,
            proto_min: PROTOCOL_MIN,
            proto_max: PROTOCOL_MAX,
            instance_id: 0,
            capabilities: 0,
            session_count: 0,
            build_id: build_id.into(),
        }
    }

    /// A host hello carrying its identity, capabilities, and live-session count.
    pub fn host(
        instance_id: u128,
        capabilities: u32,
        session_count: u32,
        build_id: impl Into<String>,
    ) -> Self {
        Hello {
            kind: HelloKind::Host,
            proto_min: PROTOCOL_MIN,
            proto_max: PROTOCOL_MAX,
            instance_id,
            capabilities,
            session_count,
            build_id: build_id.into(),
        }
    }

    /// Encode the frozen body (WITHOUT the outer `total_len` prefix).
    pub fn encode(&self) -> Vec<u8> {
        let bid = self.build_id.as_bytes();
        let mut out = Vec::with_capacity(4 + 1 + 1 + 2 + 2 + 16 + 4 + 4 + 2 + bid.len());
        out.extend_from_slice(&MAGIC);
        out.push(BOOTSTRAP_FORMAT);
        out.push(self.kind.to_u8());
        out.extend_from_slice(&self.proto_min.to_le_bytes());
        out.extend_from_slice(&self.proto_max.to_le_bytes());
        out.extend_from_slice(&self.instance_id.to_le_bytes());
        out.extend_from_slice(&self.capabilities.to_le_bytes());
        out.extend_from_slice(&self.session_count.to_le_bytes());
        out.extend_from_slice(&(bid.len() as u16).to_le_bytes());
        out.extend_from_slice(bid);
        out
    }

    /// Decode a frozen body. Trailing bytes beyond the known fields are IGNORED
    /// (forward compatibility). Returns an error on bad magic / truncation.
    pub fn decode(body: &[u8]) -> Result<Hello, BootstrapError> {
        let mut c = Cursor { b: body, i: 0 };
        let magic = c.take(4)?;
        if magic != MAGIC {
            return Err(BootstrapError("bad magic".into()));
        }
        let _format = c.u8()?; // format is read but not gated: future formats stay
                               // additive within this envelope; magic guards garbage.
        let kind = HelloKind::from_u8(c.u8()?)
            .ok_or_else(|| BootstrapError("unknown hello kind".into()))?;
        let proto_min = c.u16()?;
        let proto_max = c.u16()?;
        let instance_id = c.u128()?;
        let capabilities = c.u32()?;
        let session_count = c.u32()?;
        let bid_len = c.u16()? as usize;
        let bid = c.take(bid_len)?;
        let build_id =
            String::from_utf8(bid.to_vec()).map_err(|_| BootstrapError("build_id not utf8".into()))?;
        // Any remaining bytes are reserved additive fields — intentionally ignored.
        Ok(Hello {
            kind,
            proto_min,
            proto_max,
            instance_id,
            capabilities,
            session_count,
            build_id,
        })
    }
}

/// Pick the highest frame protocol version both peers speak, if their ranges
/// overlap. Returns `None` when there is no common version (⇒ coexist without
/// control, never force-kill sessions — design 003 §10.3/§10.4).
pub fn negotiate(client: (u16, u16), host: (u16, u16)) -> Option<u16> {
    let lo = client.0.max(host.0);
    let hi = client.1.min(host.1);
    if lo <= hi {
        Some(hi)
    } else {
        None
    }
}

/// Write a hello as `[len: u32][body]` and flush.
pub async fn write_hello<W: AsyncWrite + Unpin>(w: &mut W, hello: &Hello) -> io::Result<()> {
    let body = hello.encode();
    w.write_all(&(body.len() as u32).to_le_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await
}

/// Read one hello. Enforces [`MAX_HELLO_LEN`] BEFORE allocating the body.
pub async fn read_hello<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Hello> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_HELLO_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("hello length {len} exceeds MAX_HELLO_LEN {MAX_HELLO_LEN}"),
        ));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Hello::decode(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.0))
}

/// Bootstrap decode error.
#[derive(Debug)]
pub struct BootstrapError(pub String);

impl std::fmt::Display for BootstrapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "bootstrap decode error: {}", self.0)
    }
}
impl std::error::Error for BootstrapError {}

/// Minimal little-endian reader with bounds checks.
struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], BootstrapError> {
        let end = self
            .i
            .checked_add(n)
            .ok_or_else(|| BootstrapError("overflow".into()))?;
        if end > self.b.len() {
            return Err(BootstrapError("truncated hello".into()));
        }
        let s = &self.b[self.i..end];
        self.i = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, BootstrapError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, BootstrapError> {
        let s = self.take(2)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Result<u32, BootstrapError> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u128(&mut self) -> Result<u128, BootstrapError> {
        let s = self.take(16)?;
        let mut a = [0u8; 16];
        a.copy_from_slice(s);
        Ok(u128::from_le_bytes(a))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_hello_roundtrips() {
        let h = Hello::host(0x1122_3344_5566_7788_99aa_bbcc_ddee_ff00, CAP_DRAIN, 3, "build-abc");
        let back = Hello::decode(&h.encode()).unwrap();
        assert_eq!(back, h);
        assert_eq!(back.instance_id, 0x1122_3344_5566_7788_99aa_bbcc_ddee_ff00);
        assert_eq!(back.capabilities & CAP_DRAIN, CAP_DRAIN);
        assert_eq!(back.session_count, 3);
    }

    #[test]
    fn client_hello_roundtrips() {
        let h = Hello::client("gui-xyz");
        let back = Hello::decode(&h.encode()).unwrap();
        assert_eq!(back, h);
        assert_eq!(back.kind, HelloKind::Client);
        assert_eq!(back.instance_id, 0);
    }

    #[test]
    fn trailing_extra_bytes_are_ignored_forward_compat() {
        // A FUTURE build appends extra fields after build_id. An old parser must
        // still decode the known prefix and ignore the rest.
        let h = Hello::host(7, 0, 1, "b");
        let mut bytes = h.encode();
        bytes.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02]);
        let back = Hello::decode(&bytes).unwrap();
        assert_eq!(back, h, "unknown trailing bytes must not change the decode");
    }

    #[test]
    fn decode_rejects_bad_magic() {
        let mut bytes = Hello::client("x").encode();
        bytes[0] = b'X';
        assert!(Hello::decode(&bytes).is_err());
    }

    #[test]
    fn decode_rejects_truncation() {
        let bytes = Hello::client("hello").encode();
        assert!(Hello::decode(&bytes[..bytes.len() - 3]).is_err());
    }

    #[test]
    fn negotiate_picks_highest_common_version() {
        assert_eq!(negotiate((1, 3), (1, 2)), Some(2));
        assert_eq!(negotiate((1, 1), (1, 1)), Some(1));
        assert_eq!(negotiate((2, 4), (1, 2)), Some(2));
        // Disjoint ranges ⇒ no common version ⇒ coexist without control.
        assert_eq!(negotiate((3, 4), (1, 2)), None);
    }

    #[tokio::test]
    async fn write_then_read_roundtrips_over_stream() {
        let h = Hello::host(42, CAP_DRAIN, 5, "streamed");
        let mut pipe: Vec<u8> = Vec::new();
        write_hello(&mut pipe, &h).await.unwrap();
        let mut cursor = std::io::Cursor::new(pipe);
        let back = read_hello(&mut cursor).await.unwrap();
        assert_eq!(back, h);
    }

    #[tokio::test]
    async fn read_hello_rejects_oversized_len_before_alloc() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&((MAX_HELLO_LEN as u32) + 1).to_le_bytes());
        let mut cursor = std::io::Cursor::new(buf);
        let err = read_hello(&mut cursor).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
