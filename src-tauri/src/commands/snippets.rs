//! Snippets import/export (plan/029 §8.3) — Tauri-IPC only, deliberately absent
//! from `api_server.rs` (decision D10). Split out of the former `commands.rs`.

/// Cap on an imported snippets file (§8.3). A mistakenly-picked huge file must not
/// be slurped through IPC into the renderer.
pub const SNIPPETS_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Both commands accept only a `.json` path. Case-insensitive because a native save
/// dialog on Windows/macOS can hand back the extension in any case.
fn snippets_file_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path);
    let is_json = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"));
    if !is_json {
        return Err(format!(
            "Snippet files must have a .json extension (got \"{path}\")"
        ));
    }
    Ok(p)
}

/// Read at most `max_bytes` from `p`, refusing anything larger.
///
/// Reads through `take(max + 1)` rather than trusting `metadata().len()`: a file can
/// grow between the stat and the read, and some paths report a length of 0 while
/// streaming unbounded content. The cap is a parameter so the guard is testable
/// without writing a 5 MB fixture for every case.
fn read_json_file_capped(p: &std::path::Path, max_bytes: u64) -> Result<String, String> {
    use std::io::Read;
    let file =
        std::fs::File::open(p).map_err(|e| format!("Could not open {}: {e}", p.display()))?;
    let mut buf = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| format!("Could not read {}: {e}", p.display()))?;
    if buf.len() as u64 > max_bytes {
        return Err(format!(
            "{} is larger than the {} MB snippets import limit",
            p.display(),
            max_bytes / (1024 * 1024)
        ));
    }
    String::from_utf8(buf).map_err(|_| format!("{} is not valid UTF-8 text", p.display()))
}

/// Write the snippets export envelope (§8.1) to a user-picked `.json` path.
/// See the module note above: Tauri IPC only, never an HTTP route.
#[tauri::command]
pub fn export_snippets_file(path: String, json: String) -> Result<(), String> {
    let p = snippets_file_path(&path)?;
    std::fs::write(&p, json.as_bytes()).map_err(|e| format!("Could not write {}: {e}", p.display()))
}

/// Read a snippets export file back as text for the renderer to parse and merge
/// (§8.4). Size-capped; see the module note above: Tauri IPC only, never an HTTP route.
#[tauri::command]
pub fn import_snippets_file(path: String) -> Result<String, String> {
    let p = snippets_file_path(&path)?;
    read_json_file_capped(&p, SNIPPETS_FILE_MAX_BYTES)
}

/// Plain `#[cfg(test)]` — nothing here needs tauri's `test` feature (which breaks the
/// Windows test binary at loader time), so these run on every platform's CI.
#[cfg(test)]
mod snippet_porting_tests {
    use super::{
        export_snippets_file, import_snippets_file, read_json_file_capped, snippets_file_path,
        SNIPPETS_FILE_MAX_BYTES,
    };
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("snipport_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_json_path_is_accepted_in_any_case() {
        for name in ["a.json", "a.JSON", "a.Json", "dir.with.dots/b.json"] {
            assert!(snippets_file_path(name).is_ok(), "{name} should be accepted");
        }
    }

    #[test]
    fn a_non_json_path_is_refused_with_a_readable_message() {
        for name in ["a.txt", "a.exe", "noextension", "a.json.txt", ".json"] {
            let err = snippets_file_path(name)
                .expect_err("a non-.json path must be refused");
            assert!(
                err.contains(".json"),
                "the refusal must say what is required, got: {err}"
            );
            assert!(
                err.contains(name),
                "the refusal must name the offending path, got: {err}"
            );
        }
    }

    /// The guard has to live in BOTH commands, not just the read side — an export is
    /// the write, and it is the write that would be the dangerous primitive.
    #[test]
    fn both_commands_enforce_the_extension() {
        let dir = scratch("ext");
        let bad = dir.join("snippets.txt");
        assert!(export_snippets_file(bad.display().to_string(), "{}".into()).is_err());
        assert!(
            !bad.exists(),
            "a refused export must not have created the file"
        );
        assert!(import_snippets_file(bad.display().to_string()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_snippets_file_round_trips() {
        let dir = scratch("roundtrip");
        let path = dir.join("termflow-snippets.json").display().to_string();
        let json = "{\"version\":1,\"exportedAt\":1757000000000,\"snippets\":[{\"id\":\"sn-1\",\"text\":\"ls -la\",\"createdAt\":1}]}";

        export_snippets_file(path.clone(), json.to_string()).expect("export should succeed");
        assert_eq!(
            import_snippets_file(path).expect("import should succeed"),
            json
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_a_readable_error_not_a_panic() {
        let dir = scratch("missing");
        let path = dir.join("nope.json").display().to_string();
        let err = import_snippets_file(path).expect_err("a missing file must be an Err");
        assert!(err.contains("nope.json"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Boundary: exactly at the cap is fine, one byte over is refused. Exercised with a
    /// small cap so the case is cheap; `import_refuses_a_file_over_the_real_cap` pins
    /// that the real command actually uses the 5 MB constant.
    #[test]
    fn the_size_cap_is_inclusive_at_the_limit_and_refuses_one_byte_over() {
        let dir = scratch("cap");
        let at = dir.join("at.json");
        std::fs::write(&at, vec![b'x'; 16]).unwrap();
        assert_eq!(read_json_file_capped(&at, 16).unwrap().len(), 16);

        let over = dir.join("over.json");
        std::fs::write(&over, vec![b'x'; 17]).unwrap();
        let err =
            read_json_file_capped(&over, 16).expect_err("17 bytes must exceed a 16-byte cap");
        assert!(err.contains("larger than"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The end-to-end guard: a mutant that passed `u64::MAX` (or dropped the cap) into
    /// `read_json_file_capped` would survive the boundary test above but dies here.
    #[test]
    fn import_refuses_a_file_over_the_real_cap() {
        assert_eq!(
            SNIPPETS_FILE_MAX_BYTES,
            5 * 1024 * 1024,
            "the documented cap is 5 MB"
        );
        let dir = scratch("realcap");
        let path = dir.join("huge.json");
        std::fs::write(&path, vec![b'x'; (SNIPPETS_FILE_MAX_BYTES + 1) as usize]).unwrap();
        let err = import_snippets_file(path.display().to_string())
            .expect_err("a file over 5 MB must be refused");
        assert!(err.contains("5 MB"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_utf8_content_is_an_error_not_a_lossy_string() {
        let dir = scratch("utf8");
        let path = dir.join("bin.json");
        std::fs::write(&path, [0xff_u8, 0xfe, 0xfd]).unwrap();
        let err = import_snippets_file(path.display().to_string()).expect_err("must refuse");
        assert!(err.contains("UTF-8"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Decision D10, pinned rather than merely commented: neither command may be
    /// reachable from the embedded REST API. `api_server.rs` reuses Tauri command
    /// functions by name (e.g. `commands::spawn_routed`), so a future route that
    /// called either of these would name it here — and turn this test red.
    ///
    /// Scoped to the `api_server/` module (not the whole crate, which would also
    /// match these commands' own definitions right here in `commands.rs`) via
    /// [`crate::automation_engine::test_host::crate_sources`]'s filesystem walk —
    /// split-proof, so a future `api_server.rs` split into more files, or a brand
    /// new file under `api_server/`, stays covered without this guard needing to
    /// remember a path.
    #[test]
    fn neither_command_is_reachable_from_the_embedded_api_server() {
        let sources: Vec<_> = crate::automation_engine::test_host::crate_sources()
            .into_iter()
            .filter(|(path, _)| path == "api_server.rs" || path.starts_with("api_server/"))
            .collect();
        assert!(
            !sources.is_empty(),
            "found no api_server sources to audit — this guard must fail loudly, not pass vacuously"
        );
        for (path, src) in &sources {
            for name in ["export_snippets_file", "import_snippets_file"] {
                assert!(
                    !src.contains(name),
                    "{name} must stay off the HTTP surface (plan/029 D10): a general \
                     file read/write reachable from the local REST API or the MCP \
                     sidecar is exactly what these two narrow commands exist to avoid \
                     (found in {path})"
                );
            }
        }
    }
}
