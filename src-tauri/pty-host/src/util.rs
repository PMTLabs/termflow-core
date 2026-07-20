//! Shared helpers. `find_utf8_boundary` is ported verbatim from the GUI's
//! `pty_manager.rs` so the sidecar splits chunks on the same character
//! boundaries the in-process path always used.

/// Return the length of the longest prefix of `data` that is complete, valid
/// UTF-8 — i.e. the index at which an incomplete trailing multibyte sequence
/// begins (or `data.len()` when the whole slice is valid).
pub fn find_utf8_boundary(data: &[u8]) -> usize {
    if data.is_empty() {
        return 0;
    }
    if std::str::from_utf8(data).is_ok() {
        return data.len();
    }
    let len = data.len();
    for i in 1..=4.min(len) {
        let pos = len - i;
        let byte = data[pos];
        if byte < 0x80 || byte >= 0xC0 {
            let expected_len = if byte < 0x80 {
                1
            } else if byte < 0xE0 {
                2
            } else if byte < 0xF0 {
                3
            } else {
                4
            };
            let actual_len = len - pos;
            if actual_len < expected_len {
                return pos;
            } else if std::str::from_utf8(&data[pos..]).is_ok() {
                return len;
            } else {
                continue;
            }
        }
    }
    0
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
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
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
