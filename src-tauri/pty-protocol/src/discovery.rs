//! Host discovery record — a small per-user control file the running sidecar
//! writes so a freshly-launched (possibly newer) app can find it and learn its
//! protocol range, identity, and endpoint BEFORE connecting, and thus pick a
//! compatible codec instead of blindly speaking an incompatible one at a legacy
//! host (design 003 §10.3, review 056 C3).
//!
//! A LEGACY (Milestone-A / v1) host does NOT write this file; its **absence** is
//! how a new client detects "legacy host — speak v1 on the well-known endpoint."
//! JSON is used deliberately: a newer app reading an older host's record (the
//! update direction) must never fail to parse, so unknown fields are ignored and
//! `#[serde(default)]` covers fields older hosts didn't write.

use serde::{Deserialize, Serialize};

/// Current record format (informational). Additive fields must use
/// `#[serde(default)]` so older records still parse.
pub const HOST_RECORD_FORMAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRecord {
    #[serde(default)]
    pub format: u32,
    /// Identity of THIS host process, so a reattaching client can confirm it
    /// reconnected to the same host it armed.
    pub instance_id: u128,
    /// OS process id (liveness / staleness checks).
    pub pid: u32,
    /// Frame protocol range this host speaks.
    pub proto_min: u16,
    pub proto_max: u16,
    /// Endpoint to connect to (named-pipe name / unix socket path),
    /// instance-qualified so an old and a new host can coexist during a drain.
    pub endpoint: String,
    /// Host capability bitflags (see [`crate::bootstrap`] `CAP_*`).
    #[serde(default)]
    pub capabilities: u32,
}

impl HostRecord {
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("serialize HostRecord")
    }
    pub fn from_json(s: &str) -> Result<HostRecord, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }
}

/// Write the record atomically (temp in the same dir + rename) so a reader never
/// observes a half-written file. Creates parent dirs as needed.
pub fn write_record(path: &std::path::Path, rec: &HostRecord) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", rec.instance_id));
    std::fs::write(&tmp, rec.to_json())?;
    std::fs::rename(&tmp, path)
}

/// Read the record. `Ok(None)` when the file is absent (⇒ legacy host / none).
/// A present-but-unparseable file is an error the caller may treat as legacy.
pub fn read_record(path: &std::path::Path) -> std::io::Result<Option<HostRecord>> {
    match std::fs::read_to_string(path) {
        Ok(s) => HostRecord::from_json(&s)
            .map(Some)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Remove the record only if it belongs to `instance_id` — never delete a newer
/// host's record during our own shutdown.
pub fn remove_record_if_owned(
    path: &std::path::Path,
    instance_id: u128,
) -> std::io::Result<()> {
    match read_record(path) {
        Ok(Some(rec)) if rec.instance_id == instance_id => std::fs::remove_file(path),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec() -> HostRecord {
        HostRecord {
            format: HOST_RECORD_FORMAT,
            instance_id: 0xABCD_1234_5678_9012_3456_7890_ABCD_EF00,
            pid: 4321,
            proto_min: 1,
            proto_max: 1,
            endpoint: r"\\.\pipe\termflow-pty-host.user.rel.abc123".into(),
            capabilities: crate::bootstrap::CAP_DRAIN,
        }
    }

    fn scratch() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tfrec-{}", uuid_like()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    // Avoid a uuid dep in this tiny crate: derive a unique-ish suffix from the
    // monotonic-ish nanos of the current time.
    fn uuid_like() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    #[test]
    fn json_roundtrips() {
        let r = rec();
        assert_eq!(HostRecord::from_json(&r.to_json()).unwrap(), r);
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = scratch();
        let path = dir.join("host.json");
        let r = rec();
        write_record(&path, &r).unwrap();
        assert_eq!(read_record(&path).unwrap().unwrap(), r);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_absent_is_none() {
        let dir = scratch();
        assert!(read_record(&dir.join("nope.json")).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn newer_reads_older_ignores_unknown_and_defaults_missing() {
        // An OLDER host wrote a record without `capabilities`/`format` and WITH a
        // field a future host added. The current parser must still succeed.
        let json = r#"{
            "instance_id": 7,
            "pid": 10,
            "proto_min": 1,
            "proto_max": 1,
            "endpoint": "ep",
            "future_field": "ignored"
        }"#;
        let r = HostRecord::from_json(json).unwrap();
        assert_eq!(r.instance_id, 7);
        assert_eq!(r.capabilities, 0, "missing capabilities defaults to 0");
        assert_eq!(r.format, 0, "missing format defaults to 0");
    }

    #[test]
    fn remove_only_when_owned() {
        let dir = scratch();
        let path = dir.join("host.json");
        let r = rec();
        write_record(&path, &r).unwrap();
        // Different instance must NOT delete it.
        remove_record_if_owned(&path, r.instance_id ^ 1).unwrap();
        assert!(path.exists(), "record of another instance must survive");
        // Owner removes it.
        remove_record_if_owned(&path, r.instance_id).unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
