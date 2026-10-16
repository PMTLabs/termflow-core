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

/// Derive the profile-scoped stand-down signal path next to a survivor record.
pub fn elevated_stand_down_path_for_survivor(path: &std::path::Path) -> Option<std::path::PathBuf> {
    let name = path.file_name()?.to_str()?;
    let suffix = name.strip_prefix("elevated-survivor-")?;
    Some(path.with_file_name(format!("elevated-standdown-{suffix}")))
}

pub fn publish_elevated_survivor(path: &std::path::Path, rec: &ElevatedSurvivorRecord) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if let Some(stand_down_path) = elevated_stand_down_path_for_survivor(path) {
        match std::fs::remove_file(stand_down_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
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

/// Atomically publish the instance id of the held host that should stand down.
pub fn request_elevated_stand_down(path: &std::path::Path, instance_id: u128) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{instance_id}"));
    std::fs::write(&tmp, serde_json::to_vec(&instance_id).expect("serialize stand-down instance id"))?;
    std::fs::rename(&tmp, path)
}

/// Read the target instance id from a stand-down signal, or `None` for a missing or invalid file.
pub fn read_elevated_stand_down(path: &std::path::Path) -> Option<u128> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Remove a stand-down signal only when it still names this host instance.
pub fn remove_elevated_stand_down_if_owned(path: &std::path::Path, instance_id: u128) -> std::io::Result<()> {
    match read_elevated_stand_down(path) {
        Some(found) if found == instance_id => std::fs::remove_file(path),
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

    fn temp_rendezvous_path(tag: &str) -> std::path::PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("termflow-rendezvous-{}-{nonce}", std::process::id()))
            .join(tag)
    }

    #[test]
    fn publishing_a_survivor_clears_a_stale_stand_down() {
        let survivor_path = temp_rendezvous_path("elevated-survivor-default.json");
        let stand_down_path = super::elevated_stand_down_path_for_survivor(&survivor_path).unwrap();
        super::request_elevated_stand_down(&stand_down_path, 0xDEADBEEF_CAFE_1234).unwrap();
        let rec = super::ElevatedSurvivorRecord {
            format: 1,
            user_sid: "S-1-5-21-test".into(),
            host_pid: 9988,
            host_creation_time: 13350000000000,
            instance_id: 0xDEADBEEF_CAFE_1235,
            rendezvous_pipe: r"\\.\pipe\termflow-admin-rendezvous.test.9988.nonce".into(),
            proto_min: 1,
            proto_max: 1,
            capabilities: 0,
        };

        super::publish_elevated_survivor(&survivor_path, &rec).unwrap();

        assert_eq!(super::read_elevated_stand_down(&stand_down_path), None);
        let parent = survivor_path.parent().unwrap().to_path_buf();
        let _ = std::fs::remove_file(&survivor_path);
        let _ = std::fs::remove_file(&stand_down_path);
        let _ = std::fs::remove_dir(parent);
    }

    #[test]
    fn remove_stand_down_if_owned_spares_another_instance() {
        let path = temp_rendezvous_path("elevated-standdown-default.json");
        let owner = 0xDEADBEEF_CAFE_1234;
        super::request_elevated_stand_down(&path, owner).unwrap();

        super::remove_elevated_stand_down_if_owned(&path, owner.wrapping_add(1)).unwrap();

        assert_eq!(super::read_elevated_stand_down(&path), Some(owner));
        let parent = path.parent().unwrap().to_path_buf();
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir(parent);
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
