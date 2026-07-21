//! Shared helpers. `find_utf8_boundary` is ported verbatim from the GUI's
//! `pty_manager.rs` so the sidecar splits chunks on the same character
//! boundaries the in-process path always used.

/// Return the split point: the length of the prefix safe to forward now, so
/// that at most an *incomplete* trailing UTF-8 scalar is carried over. The
/// carry (`data.len() - result`) is bounded to ≤3 bytes, so `pending` can never
/// grow without bound (a malicious/garbled stream cannot balloon memory).
///
/// - Whole slice valid → `data.len()` (nothing carried).
/// - Trailing bytes are an *incomplete* scalar → split before them (carry ≤3).
/// - An *invalid* byte is present (not merely incomplete) → forward everything
///   and let the GUI's `from_utf8_lossy` render replacement chars; nothing is
///   carried, so no unbounded accumulation on garbage input.
pub fn find_utf8_boundary(data: &[u8]) -> usize {
    match std::str::from_utf8(data) {
        Ok(_) => data.len(),
        Err(e) => match e.error_len() {
            None => e.valid_up_to(), // incomplete trailing scalar → carry ≤3 bytes
            Some(_) => data.len(),   // invalid byte present → pass through, no carry
        },
    }
}

/// Kill a process tree by PID (taskkill /T /F on Windows; kill on Unix).
/// Mirrors the in-process `kill_process_tree` in `pty_manager.rs`. No-op for
/// pid 0 (unknown).
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: spawn taskkill without allocating a console, so the
        // detached sidecar doesn't flash a command-line window on every tab
        // close (mirrors the in-process path in `pty_manager.rs`).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_ascii_is_complete() {
        assert_eq!(find_utf8_boundary(b"hello"), 5);
    }

    #[test]
    fn split_multibyte_is_trimmed() {
        // "é" is 0xC3 0xA9; a trailing lone 0xC3 is incomplete.
        let data = [b'a', 0xC3];
        assert_eq!(find_utf8_boundary(&data), 1);
    }

    #[test]
    fn complete_multibyte_kept() {
        let s = "aé".as_bytes(); // a + C3 A9
        assert_eq!(find_utf8_boundary(s), s.len());
    }
}
