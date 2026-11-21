//! Native, read-only command projections. The paths here are labels, not a receipt.
use super::{
    launch_argv::build_launch_argv,
    session::{native_home, KnownHostsPaths},
    store::{ConnectionInput, Store, StoreError},
    target::resolve,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PreviewSource {
    Saved { id: String },
    Draft { draft: ConnectionInput, editing_id: Option<String> },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    argv: Vec<String>,
    display: String,
    store_revision: u64,
    config_notice: &'static str,
    wrapper: &'static str,
}

#[derive(Debug, Serialize)]
pub struct PreviewError {
    code: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    fields: Vec<StoreError>,
}
impl PreviewError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message, fields: vec![] }
    }
    fn unsupported() -> Self {
        Self::new("UnsupportedContext", "SSH preview requires native desktop paths.")
    }
    fn validation(error: StoreError) -> Self {
        if error.code == "not-found"
            && matches!(error.field.as_deref(), None | Some("connectionId"))
        {
            return Self::new("NotFound", "SSH connection not found.");
        }
        if matches!(error.field.as_deref(), Some("ssh" | "knownHostsPaths")) {
            return Self::unsupported();
        }
        Self { code: "Validation", message: "Check the SSH connection fields.", fields: vec![error] }
    }
}

pub fn connection_preview(store: &Store, source: PreviewSource) -> Result<Preview, PreviewError> {
    preview_in(store, source, || {
        #[cfg(windows)]
        let executable = crate::pty_manager::ssh_shell::system_shell(r"OpenSSH\ssh.exe")
            .map_err(|_| PreviewError::unsupported())?;
        #[cfg(not(windows))]
        let executable = "/usr/bin/ssh".into();
        Ok((executable, native_home()))
    })
}

fn preview_in(
    store: &Store,
    source: PreviewSource,
    native_paths: impl FnOnce() -> Result<(String, PathBuf), PreviewError>,
) -> Result<Preview, PreviewError> {
    let mut snapshot = store.preview_snapshot().map_err(|_| {
        PreviewError::new("StoreUnavailable", "SSH definitions could not be read.")
    })?;
    let id = match source {
        PreviewSource::Saved { id } => id,
        PreviewSource::Draft { mut draft, editing_id } => {
            // Replacing the edited row in memory also validates self references
            // and existing referrers, exactly as a real editor save would.
            if draft.id.is_some() && draft.id != editing_id {
                return Err(PreviewError::validation(StoreError::field("id", "editing-id-mismatch")));
            }
            draft.id = editing_id;
            snapshot.upsert_connection(draft).map_err(PreviewError::validation)?;
            snapshot.connections.last().expect("upsert appends the row").id.clone()
        }
    };
    let target = resolve(&snapshot, &id).map_err(PreviewError::validation)?;
    let (ssh, home) = native_paths()?;
    let has_jump = target.hops.len() == 2;
    let trust = preview_trust(&home, has_jump)?;
    let argv = build_launch_argv(&target, &trust, &ssh, &home)
        .map_err(PreviewError::validation)?
        .preview_argv();
    // Delimit argv unambiguously without pretending this is shell syntax.
    let display = argv.iter().map(|arg| {
        serde_json::to_string(arg).expect("a string always serializes")
    }).collect::<Vec<_>>().join(" ");
    Ok(Preview {
        argv,
        display,
        store_revision: snapshot.revision,
        config_notice: "~/.ssh/config does not apply to saved connections. Preview only; trust is not verified here.",
        wrapper: match (has_jump, cfg!(windows)) {
            (false, _) => "Direct native OpenSSH connection",
            (true, true) => "Jump via native OpenSSH ProxyCommand (shown symbolically)",
            (true, false) => "Jump via a private ProxyCommand helper (shown symbolically)",
        },
    })
}

fn preview_trust(home: &Path, has_jump: bool) -> Result<KnownHostsPaths, PreviewError> {
    if !home.is_absolute() {
        return Err(PreviewError::unsupported());
    }
    let path = home.join(".ssh/known_hosts");
    let path = path.to_str().ok_or_else(PreviewError::unsupported)?;
    Ok(KnownHostsPaths { target: path.into(), jump: has_jump.then(|| path.into()) })
}

#[cfg(test)]
#[path = "preview_tests.rs"]
mod tests;
