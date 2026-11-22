//! Plan 045: `resolve_bundled_host_path` is shared between the primary
//! sidecar's own installer and `elevated_host::launch`'s pre-elevation
//! resolver. `TERMFLOW_PTY_HOST_BIN` must never be honored in a release
//! build — `cfg!(debug_assertions)` is always `true` under `cargo test`
//! (there is no way to build the crate as `--release` from inside a unit
//! test), so this can only be pinned by reading the source, the same way
//! `elevated_host::mod::crash_tests` pins its own compile-time-only policy.

/// `resolve_bundled_host_path`'s own body, extracted by brace-counting from
/// its `pub fn resolve_bundled_host_path() -> ... {` opening — not a fixed
/// line window, which would silently stop matching once the function grew
/// or shrank.
fn resolve_bundled_host_path_body() -> String {
    let src = include_str!("../pty_host_client.rs").replace("\r\n", "\n");
    let at = src
        .find("pub fn resolve_bundled_host_path()")
        .expect("resolve_bundled_host_path not found — it moved or was renamed");
    let open = at + src[at..].find('{').expect("no `{` after the signature");
    let mut depth = 0i32;
    for (i, c) in src[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return src[open..open + i + 1].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces in resolve_bundled_host_path");
}

/// Or every assertion below is about an empty string.
#[test]
fn found_the_function_it_is_reading() {
    assert!(resolve_bundled_host_path_body().contains("TERMFLOW_PTY_HOST_BIN"));
}

/// The vulnerability this guards: a release build must never let a same-user
/// env var pick the binary this resolver hands to `elevated_host::launch`,
/// which silently UAC-elevates it. `cfg!(debug_assertions)` must appear
/// BEFORE the env var read (not merely somewhere in the function, and not
/// only around the caller's use of the result) so the read itself never
/// executes its `Some(...)` return outside a debug build.
#[test]
fn the_env_override_is_gated_to_debug_builds() {
    let body = resolve_bundled_host_path_body();
    let cfg_at = body
        .find("cfg!(debug_assertions)")
        .expect(
            "resolve_bundled_host_path must gate TERMFLOW_PTY_HOST_BIN behind \
             cfg!(debug_assertions) — a release build must never honor it. Body:\n",
        );
    let env_read_at = body
        .find("std::env::var(\"TERMFLOW_PTY_HOST_BIN\")")
        .expect("TERMFLOW_PTY_HOST_BIN read not found");
    assert!(
        cfg_at < env_read_at,
        "cfg!(debug_assertions) must guard the TERMFLOW_PTY_HOST_BIN read, not follow it. Body:\n{body}"
    );
}
