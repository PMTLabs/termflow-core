use dashmap::DashMap;
use sysinfo::{Pid, System};
use super::procinfo::{deepest_chain_cwd, foreground_chain_named};

/// Read a single process's current working directory (cross-platform via sysinfo).
fn cwd_of(sys: &System, pid: u32) -> Option<String> {
    sys.process(Pid::from(pid as usize))
        .and_then(|p| p.cwd())
        .map(|path| path.to_string_lossy().to_string())
}

/// Best-effort CWD of a terminal's foreground process. Walks to the youngest
/// descendant of `parent_pid` (so a `cd` inside a running program is reflected),
/// reading its cwd; climbs back up the chain past console hosts and levels the OS
/// won't report, ending at the shell pid, then None. Returns None when no level is
/// readable (e.g. a protected/cross-arch process on Windows) so callers can fall
/// back to the app default.
///
/// The climb is load-bearing, not defensive: the deepest link of a real agent chain is
/// `conhost.exe`, whose working directory is `C:\WINDOWS` — see [`is_console_host`] for
/// the measurement and for what accepting it broke.
///
/// NOTE: on Windows this reads the process's PEB working directory, which **cmd**
/// and Unix shells keep current but **PowerShell does NOT** update on `Set-Location`
/// — for PowerShell we rely on OSC cwd reporting (`parse_osc_cwd`) instead.
pub fn get_process_cwd(parent_pid: u32) -> Option<String> {
    get_process_cwd_with(&System::new_all(), parent_pid)
}

/// [`get_process_cwd`] against a process snapshot the caller already has.
///
/// `System::new_all()` is sysinfo's heaviest constructor (every process, plus cpu /
/// mem / disks / networks), so resolving a BATCH of terminals must scan once and
/// reuse it here, not once per terminal — see `commands::get_terminal_cwds`.
pub fn get_process_cwd_with(sys: &System, parent_pid: u32) -> Option<String> {
    let chain: Vec<(String, Option<String>)> = foreground_chain_named(parent_pid, sys)
        .into_iter()
        .map(|(pid, name)| (name, cwd_of(sys, pid)))
        .collect();
    deepest_chain_cwd(&chain)
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Decode a `file://host/path` URI (OSC 7 payload) to a filesystem path, undoing
/// percent-encoding. Drops the scheme + host; on Windows a leading `/C:/...` becomes
/// `C:/...`. Percent-decoding operates on BYTES (re-assembled with `from_utf8_lossy`)
/// so a `%`-encoded multi-byte UTF-8 path decodes correctly and never panics on a
/// non-char-boundary slice.
fn file_uri_to_path(uri: &str) -> Option<String> {
    let after_scheme = uri.strip_prefix("file://")?;
    // Skip the host component up to the first '/'.
    let path_part = match after_scheme.find('/') {
        Some(i) => &after_scheme[i..],
        None => after_scheme,
    };
    let bytes = path_part.as_bytes();
    let mut out_bytes: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out_bytes.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out_bytes.push(bytes[i]);
        i += 1;
    }
    let mut out = String::from_utf8_lossy(&out_bytes).into_owned();
    // `/C:/...` -> `C:/...` on Windows.
    if out.len() >= 3 && out.as_bytes()[0] == b'/' && out.as_bytes()[2] == b':' {
        out.remove(0);
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Scan a PTY output chunk for a shell-reported working directory, emitted as an
/// OSC sequence: `ESC ] 9 ; 9 ; <path> ST` (ConEmu/Windows-Terminal style, what our
/// PowerShell integration sends) or `ESC ] 7 ; file://host/<path> ST` (OSC 7, used
/// by many bash/zsh setups). ST is BEL (0x07) or `ESC \`. Returns the LAST cwd in
/// the chunk, if any. Per-chunk only — a sequence split across reads is missed and
/// re-reported on the next prompt.
pub fn parse_osc_cwd(data: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(data);
    let mut last: Option<String> = None;
    for (idx, _) in s.match_indices("\u{1b}]") {
        let rest = &s[idx + 2..];
        let Some(end) = rest.find('\u{07}').or_else(|| rest.find("\u{1b}\\")) else {
            continue;
        };
        let payload = &rest[..end];
        if let Some(p) = payload.strip_prefix("9;9;") {
            if !p.is_empty() {
                last = Some(p.to_string());
            }
        } else if let Some(p) = payload.strip_prefix("7;") {
            if let Some(path) = file_uri_to_path(p) {
                last = Some(path);
            }
        }
    }
    last
}

/// Last-known cwd for a terminal, for the exit event (spec 045 §3.3).
/// MUST be called BEFORE `cleanup_terminal_state`, which removes `terminal_cwds`
/// — after cleanup this is unrecoverable and the renderer would silently fall
/// back to the profile default.
///
/// The OSC-reported cwd is the ONLY source here. Unlike `commands::get_terminal_cwd`
/// there is deliberately NO `get_process_cwd(pid)` fallback, because this runs from
/// the PTY reader loop only once that loop has BROKEN — i.e. the shell is already
/// dead. Scanning for its pid would:
///   1. almost always return None anyway (the process is gone), while
///   2. paying a full `System::new_all()` scan ON THE READER THREAD, delaying the
///      `terminal:exit` emit + cleanup by ~100-500ms (late ended-tint/banner), and
///   3. worst of all, silently return the WRONG directory if the OS had already
///      RECYCLED that pid onto an unrelated process — restart would then open in a
///      random directory, attributed to this terminal.
///
/// Non-PowerShell shells (cmd/bash/WSL/zsh), which never populate `terminal_cwds`,
/// lose nothing: the renderer's 30s `refreshLiveCwds` tick already snapshots their
/// cwd from a LIVE process, `setCwdSnapshot` ignores a falsy value so a `cwd: None`
/// exit payload cannot erase it, and restart precedence is
/// `getCwdSnapshot ?? takeInitialCwd ?? profile` — so they resume in the last
/// refreshed directory.
///
/// Takes the map directly (rather than `&AppState`) so this can be unit tested
/// without constructing a full `AppState`, which requires a real `AppHandle<Wry>`
/// (`tauri::test::mock_app()` yields `AppState<MockRuntime>` instead, and only
/// under the Linux/macOS-only `integration-tests` feature — see `api_server.rs`).
pub(crate) fn exit_cwd_for(terminal_cwds: &DashMap<String, String>, id: &str) -> Option<String> {
    terminal_cwds.get(id).map(|cwd| cwd.value().clone())
}

#[cfg(test)]
mod tests {
    use super::parse_osc_cwd;
    use super::{get_process_cwd, get_process_cwd_with};
    use sysinfo::System;

    #[test]
    fn osc_9_9_with_bel() {
        let data = b"prompt\x1b]9;9;D:\\sources\\demo\x07$ ";
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("D:\\sources\\demo"));
    }

    #[test]
    fn osc_9_9_with_st() {
        let data = b"\x1b]9;9;/home/u/proj\x1b\\> ";
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("/home/u/proj"));
    }

    #[test]
    fn osc_7_file_uri() {
        let data = b"\x1b]7;file://host/home/u/my%20proj\x07";
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("/home/u/my proj"));
    }

    #[test]
    fn osc_7_windows_drive() {
        let data = b"\x1b]7;file://host/C:/work/app\x07";
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("C:/work/app"));
    }

    #[test]
    fn osc_7_percent_encoded_non_ascii_decodes_without_panic() {
        // %C3%A9 is UTF-8 for 'é'; a raw '%' followed by a multi-byte char must not panic.
        let data = "\u{1b}]7;file://host/home/u/caf%C3%A9\u{07}".as_bytes();
        assert_eq!(parse_osc_cwd(data).as_deref(), Some("/home/u/café"));
        let raw_pct = "\u{1b}]9;9;D:\\a%中\u{07}".as_bytes();
        // OSC 9;9 isn't percent-decoded, but this must also not panic.
        assert_eq!(parse_osc_cwd(raw_pct).as_deref(), Some("D:\\a%中"));
    }

    #[test]
    fn returns_last_cwd_and_ignores_plain_text() {
        let data = b"no osc here";
        assert_eq!(parse_osc_cwd(data), None);
        let two = b"\x1b]9;9;/a\x07 ... \x1b]9;9;/b\x07";
        assert_eq!(parse_osc_cwd(two).as_deref(), Some("/b"));
    }

    /// The batch command (`commands::get_terminal_cwds`) resolves EVERY requested pid
    /// against one shared `System::new_all()` instead of paying that scan per terminal.
    /// That reuse is only safe if it is a faithful projection of the owned-scan
    /// version, which is what this pins.
    #[test]
    fn process_cwd_with_a_shared_system_matches_the_owned_scan() {
        let pid = std::process::id();
        let sys = System::new_all();
        assert_eq!(get_process_cwd_with(&sys, pid), get_process_cwd(pid));
    }

    #[test]
    fn process_cwd_resolves_for_current_process() {
        // The test binary has no child processes, so the foreground walk returns
        // the test pid itself; its cwd must equal the process's working directory.
        let pid = std::process::id();
        let got = get_process_cwd(pid);
        // cwd() can be None on a locked-down platform; only assert when present.
        if let Some(cwd) = got {
            let expected = std::env::current_dir().unwrap();
            assert_eq!(std::path::Path::new(&cwd), expected.as_path());
        }
    }

    // exit_cwd_for takes the DashMap directly rather than `&AppState`: an
    // `AppState<Wry>` (what spawn_terminal/exit_cwd_for actually use) needs a real
    // `AppHandle<Wry>`, which cannot be constructed in a unit test on this platform
    // (`tauri::test::mock_app()` yields `AppState<MockRuntime>`, gated behind the
    // Linux/macOS-only `integration-tests` feature — see api_server.rs). Testing
    // the map directly exercises the same logic without that machinery.
    use super::exit_cwd_for;
    use dashmap::DashMap;

    /// Spec 045 §3.3: the exit payload must carry the cwd, because
    /// cleanup_terminal_state() wipes `terminal_cwds` BEFORE the event is emitted
    /// — so a renderer-side get_terminal_cwd() after the event can only ever
    /// return None. This pins the ordering the fix depends on. The removal below
    /// mirrors exactly what cleanup_terminal_state does to this map.
    #[test]
    fn exit_cwd_is_read_before_cleanup_wipes_it() {
        let terminal_cwds: DashMap<String, String> = DashMap::new();
        terminal_cwds.insert("t-1".to_string(), "D:\\work\\project".to_string());

        // What the exit path must do: capture first...
        let captured = exit_cwd_for(&terminal_cwds, "t-1");
        assert_eq!(captured.as_deref(), Some("D:\\work\\project"));

        // ...then clean up. After cleanup the value is unrecoverable.
        terminal_cwds.remove("t-1");
        assert!(exit_cwd_for(&terminal_cwds, "t-1").is_none());
    }

    #[test]
    fn exit_cwd_is_none_for_an_unknown_terminal() {
        let terminal_cwds: DashMap<String, String> = DashMap::new();
        assert!(exit_cwd_for(&terminal_cwds, "nope").is_none());
    }

    /// Replaces `exit_cwd_falls_back_to_live_process_cwd_when_absent_from_terminal_cwds`,
    /// which was green over a branch production can never reach: it fed exit_cwd_for
    /// the TEST BINARY's own (live) pid, while in production exit_cwd_for only ever
    /// runs after the PTY reader loop broke — i.e. the shell's pid is already DEAD.
    /// The scan therefore returned None (after a costly `System::new_all()` on the
    /// reader thread), or, if the OS had recycled the pid, some unrelated process's
    /// directory. The fallback is gone; a miss must be a cheap, honest None.
    ///
    /// Non-PowerShell shells (the ones that never populate `terminal_cwds`) are
    /// covered by the renderer's live `refreshLiveCwds` tick instead — see the
    /// exit_cwd_for doc comment.
    #[test]
    fn exit_cwd_is_none_when_no_osc_cwd_was_reported() {
        let terminal_cwds: DashMap<String, String> = DashMap::new();
        // A cmd/bash terminal: known to the app, but it never reported an OSC cwd.
        // Even with a resolvable live pid available, exit_cwd_for must not go
        // looking for one — at exit time that pid is dead and possibly recycled.
        terminal_cwds.insert("other".to_string(), "D:\\elsewhere".to_string());
        assert!(exit_cwd_for(&terminal_cwds, "t-1").is_none());
    }
}
