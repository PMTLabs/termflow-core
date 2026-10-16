//! Protocol frames and survivor records for the High-integrity rendezvous (Plan 058).
//!
//! Exchanged exclusively over the High-integrity rendezvous pipe between the
//! elevated UAC reconnect helper (High client) and the held elevated host (High server).

use serde::{Deserialize, Serialize};
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const ELEVATED_RENDEZVOUS_VERSION: u32 = 1;
pub const MAX_RENDEZVOUS_FRAME_LEN: usize = 64 * 1024;

/// Request sent by the High UAC helper to the held elevated host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElevatedRendezvousRequest {
    pub version: u32,
    pub gui_pid: u32,
    pub target_pipe: String,
    pub auth_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ElevatedRendezvousStatus {
    Ok,
    Rejected(String),
}

/// Reply sent by the held elevated host to the High UAC helper.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElevatedRendezvousResponse {
    pub status: ElevatedRendezvousStatus,
    pub capabilities: u32,
    pub protocol_version: u8,
}

/// Profile-scoped elevated survivor record written during hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElevatedSurvivorRecord {
    #[serde(default)]
    pub format: u32,
    pub user_sid: String,
    pub host_pid: u32,
    pub host_creation_time: u64,
    pub instance_id: u128,
    pub rendezvous_pipe: String,
    pub proto_min: u16,
    pub proto_max: u16,
    #[serde(default)]
    pub capabilities: u32,
}

impl ElevatedSurvivorRecord {
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("serialize ElevatedSurvivorRecord")
    }
    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }
}

/// Prefix every elevated rendezvous pipe name starts with.
pub const RENDEZVOUS_PIPE_PREFIX: &str = r"\\.\pipe\termflow-admin-rendezvous.";

/// The rendezvous pipe a held elevated host listens on. `nonce` is unpredictable and chosen by
/// the host when it enters Hold, so a same-user process cannot pre-create the name (the pid and
/// SID alone are guessable) and keep the real host from ever being reachable.
pub fn rendezvous_pipe_name(user_sid: &str, host_pid: u32, nonce: &str) -> String {
    format!("{RENDEZVOUS_PIPE_PREFIX}{user_sid}.{host_pid}.{nonce}")
}

/// True only for a well-formed rendezvous pipe name. The name is read back from a record that any
/// same-user process can edit and is then placed on the command line of an ELEVATED process, so
/// anything that is not plainly a pipe name (quotes, spaces, backslashes, extra flags) is refused.
pub fn is_valid_rendezvous_pipe_name(name: &str) -> bool {
    match name.strip_prefix(RENDEZVOUS_PIPE_PREFIX) {
        Some(rest) => {
            !rest.is_empty()
                && rest.len() <= 200
                && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        }
        None => false,
    }
}

pub fn publish_elevated_survivor(path: &std::path::Path, rec: &ElevatedSurvivorRecord) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", rec.instance_id));
    std::fs::write(&tmp, rec.to_json())?;
    std::fs::rename(&tmp, path)
}

pub fn read_elevated_survivor(path: &std::path::Path) -> std::io::Result<Option<ElevatedSurvivorRecord>> {
    match std::fs::read_to_string(path) {
        Ok(s) => ElevatedSurvivorRecord::from_json(&s)
            .map(Some)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn remove_elevated_survivor_if_owned(path: &std::path::Path, instance_id: u128) -> std::io::Result<()> {
    match read_elevated_survivor(path) {
        Ok(Some(rec)) if rec.instance_id == instance_id => std::fs::remove_file(path),
        _ => Ok(()),
    }
}

pub async fn write_rendezvous_request<W: AsyncWrite + Unpin>(
    w: &mut W,
    req: &ElevatedRendezvousRequest,
) -> io::Result<()> {
    let payload = serde_json::to_vec(req).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    w.write_all(&(payload.len() as u32).to_le_bytes()).await?;
    w.write_all(&payload).await?;
    w.flush().await
}

pub async fn read_rendezvous_request<R: AsyncRead + Unpin>(
    r: &mut R,
) -> io::Result<ElevatedRendezvousRequest> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_RENDEZVOUS_FRAME_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("rendezvous request len {len} exceeds MAX_RENDEZVOUS_FRAME_LEN {MAX_RENDEZVOUS_FRAME_LEN}"),
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub async fn write_rendezvous_response<W: AsyncWrite + Unpin>(
    w: &mut W,
    resp: &ElevatedRendezvousResponse,
) -> io::Result<()> {
    let payload = serde_json::to_vec(resp).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    w.write_all(&(payload.len() as u32).to_le_bytes()).await?;
    w.write_all(&payload).await?;
    w.flush().await
}

pub async fn read_rendezvous_response<R: AsyncRead + Unpin>(
    r: &mut R,
) -> io::Result<ElevatedRendezvousResponse> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_RENDEZVOUS_FRAME_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("rendezvous response len {len} exceeds MAX_RENDEZVOUS_FRAME_LEN {MAX_RENDEZVOUS_FRAME_LEN}"),
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    #[test]
    fn rendezvous_pipe_names_round_trip_through_the_validator() {
        let name = super::rendezvous_pipe_name("S-1-5-21-123-456-789-1001", 9988, "0123456789abcdef");
        assert_eq!(
            name,
            r"\\.\pipe\termflow-admin-rendezvous.S-1-5-21-123-456-789-1001.9988.0123456789abcdef"
        );
        assert!(super::is_valid_rendezvous_pipe_name(&name));
        // A record written before the nonce existed is still a plain pipe name.
        assert!(super::is_valid_rendezvous_pipe_name(
            r"\\.\pipe\termflow-admin-rendezvous.S-1-5-21-123-456-789-1001.9988"
        ));
    }

    #[test]
    fn the_validator_refuses_anything_that_could_carry_a_flag() {
        let base = r"\\.\pipe\termflow-admin-rendezvous.S-1-5-21.1";
        for bad in [
            format!(r#"{base}" --connect-pipe \\.\pipe\evil"#),
            format!("{base} --gui-pid 1"),
            format!(r"{base}\x"),
            format!("{base}\""),
            r"\\.\pipe\other-pipe".to_string(),
            r"\\server\pipe\termflow-admin-rendezvous.S-1-5-21.1".to_string(),
            super::RENDEZVOUS_PIPE_PREFIX.to_string(),
            String::new(),
        ] {
            assert!(!super::is_valid_rendezvous_pipe_name(&bad), "accepted {bad:?}");
        }
    }

    use super::*;

    #[tokio::test]
    async fn request_roundtrips_over_stream() {
        let req = ElevatedRendezvousRequest {
            version: ELEVATED_RENDEZVOUS_VERSION,
            gui_pid: 12345,
            target_pipe: r"\\.\pipe\test-gui-pipe".into(),
            auth_token: "secret-token-123".into(),
        };
        let mut pipe = Vec::new();
        write_rendezvous_request(&mut pipe, &req).await.unwrap();
        let mut cursor = std::io::Cursor::new(pipe);
        let back = read_rendezvous_request(&mut cursor).await.unwrap();
        assert_eq!(back, req);
    }

    #[tokio::test]
    async fn response_roundtrips_over_stream() {
        let resp = ElevatedRendezvousResponse {
            status: ElevatedRendezvousStatus::Ok,
            capabilities: 0x3F,
            protocol_version: 1,
        };
        let mut pipe = Vec::new();
        write_rendezvous_response(&mut pipe, &resp).await.unwrap();
        let mut cursor = std::io::Cursor::new(pipe);
        let back = read_rendezvous_response(&mut cursor).await.unwrap();
        assert_eq!(back, resp);
    }

    #[test]
    fn survivor_record_roundtrips_json() {
        let rec = ElevatedSurvivorRecord {
            format: 1,
            user_sid: "S-1-5-21-123-456-789-1001".into(),
            host_pid: 9988,
            host_creation_time: 13350000000000,
            instance_id: 0xDEADBEEF_CAFE_1234,
            rendezvous_pipe: r"\\.\pipe\termflow-admin-rendezvous.S-1-5-21-123-456-789-1001.9988".into(),
            proto_min: 1,
            proto_max: 1,
            capabilities: 0x1F,
        };
        let json = rec.to_json();
        let back = ElevatedSurvivorRecord::from_json(&json).unwrap();
        assert_eq!(back, rec);
    }
}
