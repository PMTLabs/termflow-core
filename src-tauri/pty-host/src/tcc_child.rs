//! Shared entry point for the host's one-shot TCC child and its test fixture.
use std::io::{self, Write};
use termflow_macos_tcc::{PermissionKind, PermissionState as NativeState, Tcc};
use termflow_pty_protocol::PermissionState;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChildOutput {
    pub accessibility: PermissionState,
    pub screen_recording: PermissionState,
}
pub fn convert(state: NativeState) -> PermissionState {
    match state {
        NativeState::Granted => PermissionState::Granted,
        NativeState::NotGranted => PermissionState::NotGranted,
        NativeState::Unsupported => PermissionState::Unsupported,
        NativeState::Unknown => PermissionState::Unknown,
    }
}

/// Returns false only when this is not a TCC invocation. Invalid TCC modes
/// fail closed instead of falling through into socket/record startup.
pub fn entry(args: &[String], backend: &dyn Tcc, out: &mut impl Write) -> io::Result<bool> {
    if args.first().map(String::as_str) != Some("--tcc") {
        return Ok(false);
    }
    let output = match args.get(1).map(String::as_str) {
        Some("status") if args.len() == 2 => {
            let (accessibility, screen_recording) = backend.status();
            ChildOutput {
                accessibility: convert(accessibility),
                screen_recording: convert(screen_recording),
            }
        }
        Some("request-sc") if args.len() == 2 => ChildOutput {
            accessibility: PermissionState::Unknown,
            screen_recording: convert(backend.request(PermissionKind::ScreenRecording)),
        },
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid --tcc mode",
            ))
        }
    };
    serde_json::to_writer(&mut *out, &output)?;
    writeln!(out)?;
    Ok(true)
}
