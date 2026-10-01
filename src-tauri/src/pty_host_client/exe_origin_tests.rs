//! Host image-path classification. The path-shape table runs on every OS (forward
//! slashes parse as separators on both); the live-connection lookups are
//! Windows-only.
use super::exe_origin::{classify_exe, generation_of_image, path_within, spawned_from_bundled_fallback};
use super::*;
use std::path::Path;

const ROOT: &str = "C:/Users/u/AppData/Local/TermFlow";
const RUNTIME: &str = "C:/Users/u/AppData/Local/app.termflow.desktop/host";

fn cls(image: &str, root: Option<&str>, runtime: Option<&str>) -> Option<bool> {
    classify_exe(
        Some(Path::new(image)),
        root.map(Path::new),
        runtime.map(Path::new),
        false,
        true,
    )
}

#[test]
fn a_host_under_the_velopack_root_is_in_the_payload() {
    for image in [
        "C:/Users/u/AppData/Local/TermFlow/current/termflow-pty-host.exe",
        "C:/Users/u/AppData/Local/TermFlow/termflow-pty-host.exe",
        "C:/Users/u/AppData/Local/TermFlow/current/bin/deep/termflow-pty-host.exe",
    ] {
        assert_eq!(cls(image, Some(ROOT), Some(RUNTIME)), Some(true), "{image}");
    }
}

/// A string-prefix match calls `TermFlowOther` part of `TermFlow`; a component
/// match does not.
#[test]
fn a_sibling_dir_sharing_the_root_name_prefix_is_not_in_the_payload() {
    for image in [
        "C:/Users/u/AppData/Local/TermFlowOther/current/termflow-pty-host.exe",
        "C:/Users/u/AppData/Local/TermFlow2/termflow-pty-host.exe",
        "C:/Users/u/AppData/Local/TermFlow-dev/current/termflow-pty-host.exe",
    ] {
        assert!(image.starts_with(ROOT), "the naive prefix test would say inside: {image}");
        assert_eq!(cls(image, Some(ROOT), Some(RUNTIME)), Some(false), "{image}");
    }
}

#[test]
fn other_localappdata_dirs_are_not_in_the_payload() {
    for image in [
        "C:/Users/u/AppData/Local/Temp/termflow-pty-host.exe",
        "C:/Users/u/AppData/Local/Programs/TermFlow/termflow-pty-host.exe",
        "C:/Users/u/AppData/Local/termflow-pty-host.exe",
        "D:/Users/u/AppData/Local/TermFlow/current/termflow-pty-host.exe",
    ] {
        assert_eq!(cls(image, Some(ROOT), Some(RUNTIME)), Some(false), "{image}");
    }
}

#[test]
fn the_runtime_dir_is_safe() {
    let image = "C:/Users/u/AppData/Local/app.termflow.desktop/host/rel/0123456789abcdef/termflow-pty-host.exe";
    assert_eq!(cls(image, Some(ROOT), Some(RUNTIME)), Some(false));
}

/// The runtime dir is checked before the root, so it stays safe even in a layout
/// where the root would contain it.
#[test]
fn the_runtime_dir_stays_safe_when_the_root_would_contain_it() {
    let image = "C:/Users/u/AppData/Local/app.termflow.desktop/host/rel/0123456789abcdef/termflow-pty-host.exe";
    let wide_root = "C:/Users/u/AppData/Local";
    assert_eq!(cls(image, Some(wide_root), Some(RUNTIME)), Some(false));
}

/// The classifier is handed the PARENT of the profile's runtime dir (so any
/// profile's host is safe). Built from the real layout function, the install
/// location of a host in it is outside a root that sits next to it, and so is one
/// of another profile.
#[test]
fn a_host_installed_where_the_app_installs_it_is_outside_the_payload() {
    let Some(profile_dir) = runtime_host_dir() else { return };
    let hosts_dir = profile_dir.parent().expect("the runtime dir has a parent").to_path_buf();
    let app_dir = hosts_dir.parent().expect("the host dir sits in the app's data dir");
    assert_eq!(hosts_dir.file_name().and_then(|n| n.to_str()), Some("host"), "{}", hosts_dir.display());
    assert_eq!(app_dir.file_name().and_then(|n| n.to_str()), Some("app.termflow.desktop"), "{}", app_dir.display());
    let root = app_dir.parent().expect("a layout deep enough to have a root");
    for image in [
        profile_dir.join("0123456789abcdef").join("termflow-pty-host.exe"),
        hosts_dir.join("another.profile").join("fedcba9876543210").join("termflow-pty-host.exe"),
    ] {
        assert_eq!(
            classify_exe(Some(&image), Some(root), Some(&hosts_dir), false, true),
            Some(false),
            "{}",
            image.display()
        );
    }
}

/// The pre-runtime-dir location lived inside the root and died with every update.
#[test]
fn the_old_in_root_host_location_is_in_the_payload() {
    let image = "C:/Users/u/AppData/Local/TermFlow/host/rel/0123456789abcdef/termflow-pty-host.exe";
    assert_eq!(cls(image, Some(ROOT), Some(RUNTIME)), Some(true));
}

#[test]
fn the_bundled_fallback_is_in_the_payload_whatever_the_image() {
    for image in [
        None,
        Some("C:/Users/u/AppData/Local/app.termflow.desktop/host/rel/x/termflow-pty-host.exe"),
        Some("C:/elsewhere/termflow-pty-host.exe"),
    ] {
        let got = classify_exe(
            image.map(Path::new),
            Some(Path::new(ROOT)),
            Some(Path::new(RUNTIME)),
            true,
            true,
        );
        assert_eq!(got, Some(true), "{image:?}");
    }
}

#[test]
fn case_differences_follow_the_platform() {
    let image = "C:/USERS/U/APPDATA/LOCAL/TERMFLOW/CURRENT/TERMFLOW-PTY-HOST.EXE";
    let on = |ci| classify_exe(Some(Path::new(image)), Some(Path::new(ROOT)), None, false, ci);
    assert_eq!(on(true), Some(true), "Windows paths are case-insensitive");
    assert_eq!(on(false), Some(false), "elsewhere they are not");
    // And the safe side of the same rule.
    let runtime_image = "C:/USERS/U/APPDATA/LOCAL/APP.TERMFLOW.DESKTOP/HOST/REL/X/H.EXE";
    let got = classify_exe(
        Some(Path::new(runtime_image)),
        Some(Path::new("C:/Users/u/AppData/Local")),
        Some(Path::new(RUNTIME)),
        false,
        true,
    );
    assert_eq!(got, Some(false));
}

/// Unknown is not safe: a failed lookup must not read as "outside the payload".
#[test]
fn a_failed_lookup_fails_closed() {
    assert_eq!(
        classify_exe(None, Some(Path::new(ROOT)), Some(Path::new(RUNTIME)), false, true),
        None
    );
    assert_eq!(classify_exe(None, None, None, false, true), None);
}

#[test]
fn without_a_velopack_root_nothing_is_in_the_payload() {
    let image = "C:/Users/u/AppData/Local/TermFlow/current/termflow-pty-host.exe";
    assert_eq!(cls(image, None, Some(RUNTIME)), Some(false));
}

#[test]
fn dot_segments_and_trailing_separators_are_resolved() {
    let into_root = "C:/Users/u/AppData/Local/TermFlowOther/../TermFlow/current/./h.exe";
    assert_eq!(cls(into_root, Some(ROOT), None), Some(true));
    let out_of_root = "C:/Users/u/AppData/Local/TermFlow/../TermFlowOther/h.exe";
    assert_eq!(cls(out_of_root, Some(ROOT), None), Some(false));
    let image = "C:/Users/u/AppData/Local/TermFlow/current/h.exe";
    assert_eq!(cls(image, Some("C:/Users/u/AppData/Local/TermFlow/"), None), Some(true));
}

/// Real directories: canonicalisation resolves `..` through existing dirs and the
/// verbatim `\\?\` form Windows returns for them.
#[test]
fn real_paths_are_canonicalised_before_comparing() {
    let tmp = test_dirs::tempdir().unwrap();
    let root = tmp.path().join("TermFlow");
    let other = tmp.path().join("TermFlowOther");
    std::fs::create_dir_all(root.join("current")).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let inside = root.join("current").join("h.exe");
    let outside = other.join("h.exe");
    std::fs::write(&inside, b"x").unwrap();
    std::fs::write(&outside, b"x").unwrap();

    let via_dotdot_in = other.join("..").join("TermFlow").join("current").join("h.exe");
    let via_dotdot_out = root.join("current").join("..").join("..").join("TermFlowOther").join("h.exe");
    assert!(path_within(&via_dotdot_in, &root, true));
    assert!(!path_within(&via_dotdot_out, &root, true));

    // One side canonicalised (verbatim on Windows), the other as typed.
    let canonical_root = std::fs::canonicalize(&root).unwrap();
    assert!(path_within(&inside, &canonical_root, true));
    assert!(path_within(&std::fs::canonicalize(&inside).unwrap(), &root, true));
    assert!(!path_within(&outside, &canonical_root, true));
}

#[test]
fn the_bundled_fallback_decision() {
    let runtime = Path::new("/home/u/.local/share/app.termflow.desktop/host/rel");
    let installed = Path::new("/home/u/.local/share/app.termflow.desktop/host/rel/0123456789abcdef/termflow-pty-host");
    let bundled = Path::new("/opt/termflow/termflow-pty-host");
    let sibling = Path::new("/home/u/.local/share/app.termflow.desktop/host/rel2/0123/termflow-pty-host");
    let decide = |spawned, path, dir| spawned_from_bundled_fallback(spawned, path, dir, false);

    assert!(decide(true, bundled, Some(runtime)), "spawned from the bundled source");
    assert!(decide(true, bundled, None), "no runtime dir at all");
    assert!(!decide(true, installed, Some(runtime)), "the normal installed copy");
    assert!(decide(true, sibling, Some(runtime)), "a sibling dir is not the runtime dir");
    assert!(!decide(false, bundled, Some(runtime)), "an adopted host's origin is not ours to claim");
    assert!(!decide(false, bundled, None));
}

// --- generation of an image ----------------------------------------------

const INSTALL_BASE: &str = "C:/Users/u/AppData/Local/app.termflow.desktop/host/rel";
const GENERATION: &str = "0123456789abcdef";

fn generation(image: &str, base: &str) -> Option<String> {
    generation_of_image(Path::new(image), Path::new(base), true)
}

/// Only `<install base>/<generation>/<exe>` names a generation. The bundled copy,
/// the legacy layout without a generation directory, another profile's install
/// base and a longer path sharing the base's prefix name none, so none of them
/// can be mistaken for the running build's.
#[test]
fn only_an_image_one_generation_dir_below_the_install_base_names_a_generation() {
    let installed = format!("{INSTALL_BASE}/{GENERATION}/termflow-pty-host.exe");
    assert_eq!(generation(&installed, INSTALL_BASE).as_deref(), Some(GENERATION));
    assert_eq!(
        generation(&installed.replace(GENERATION, &GENERATION.to_uppercase()), &INSTALL_BASE.to_uppercase())
            .as_deref(),
        Some(GENERATION),
        "case differences are not differences on Windows, and the name is normalised"
    );

    for (image, base) in [
        (format!("{INSTALL_BASE}/termflow-pty-host.exe"), INSTALL_BASE),
        (format!("{INSTALL_BASE}/current/termflow-pty-host.exe"), INSTALL_BASE),
        (format!("{INSTALL_BASE}/{GENERATION}/bin/termflow-pty-host.exe"), INSTALL_BASE),
        (format!("{INSTALL_BASE}2/{GENERATION}/termflow-pty-host.exe"), INSTALL_BASE),
        (format!("{INSTALL_BASE}/{GENERATION}/termflow-pty-host.exe"), "C:/elsewhere/host/rel"),
        ("C:/Users/u/AppData/Local/TermFlow/current/termflow-pty-host.exe".to_string(), INSTALL_BASE),
    ] {
        assert_eq!(generation(&image, base), None, "{image} under {base}");
    }
}

#[tokio::test]
async fn a_client_reports_a_generation_only_from_an_image_it_can_place() {
    let base = crate::pty_host_client::runtime_host_dir().expect("a per-user runtime dir");
    let (client, _server, _c) = conn_tests::wired();

    client.inject_exe_image(Some(base.join(GENERATION).join("termflow-pty-host")));
    assert_eq!(client.image_generation().as_deref(), Some(GENERATION));

    client.inject_exe_image(Some(std::path::PathBuf::from("/opt/termflow/termflow-pty-host")));
    assert_eq!(client.image_generation(), None, "an image outside the install base");
    client.inject_exe_image(None);
    assert_eq!(client.image_generation(), None, "a failed lookup");
}

#[tokio::test]
async fn only_a_host_this_app_started_is_marked_as_spawned_here() {
    let bundled = Path::new("/definitely/not/the/runtime/dir/termflow-pty-host");
    let (spawned, _server, _c) = conn_tests::wired();
    spawned.note_bundled_fallback(HostConnectionOrigin::SpawnedHere, bundled);
    assert!(spawned.spawned_here());

    let (adopted, _server, _c) = conn_tests::wired();
    adopted.note_bundled_fallback(HostConnectionOrigin::Adopted, bundled);
    assert!(!adopted.spawned_here(), "finding a running host is not starting it");
}

// --- client level -------------------------------------------------------

#[tokio::test]
async fn self_spawned_bundled_fallback_host_is_in_payload_on_every_platform() {
    let (client, _server, _c) = conn_tests::wired();
    // No pid, no image path, no root: only the spawn-time fact is available.
    let bundled = Path::new("/definitely/not/the/runtime/dir/termflow-pty-host");
    client.note_bundled_fallback(HostConnectionOrigin::SpawnedHere, bundled);
    assert_eq!(client.exe_origin.in_payload(None, None), Some(true));
    assert_eq!(client.exe_origin.in_payload(Some(Path::new(ROOT)), Some(Path::new(RUNTIME))), Some(true));

    // The same path adopted instead of spawned proves nothing about the payload.
    let (adopted, _server, _c) = conn_tests::wired();
    adopted.note_bundled_fallback(HostConnectionOrigin::Adopted, bundled);
    assert_ne!(adopted.exe_origin.in_payload(None, None), Some(true));
}

#[cfg(not(windows))]
#[tokio::test]
async fn classifier_non_windows_adopted_is_some_false_never_none() {
    let (client, _server, _c) = conn_tests::wired();
    client.note_bundled_fallback(HostConnectionOrigin::Adopted, Path::new("/opt/termflow/termflow-pty-host"));
    assert_eq!(client.exe_origin.in_payload(None, None), Some(false));
    assert_eq!(client.exe_origin.in_payload(Some(Path::new("/opt/termflow")), None), Some(false));
    assert_eq!(client.exe_in_payload(), Some(false));
}

#[test]
fn the_unknown_origin_exception_is_logged_once() {
    use std::sync::atomic::AtomicBool;
    let flag = AtomicBool::new(false);
    assert!(exe_origin::first_time(&flag));
    assert!(!exe_origin::first_time(&flag));
    assert!(!exe_origin::first_time(&flag));
}

#[cfg(windows)]
mod windows_lookup {
    use super::*;
    use tokio::net::windows::named_pipe::ServerOptions;

    fn own_exe() -> std::path::PathBuf {
        std::env::current_exe().unwrap()
    }

    #[test]
    fn the_image_path_of_a_live_process_is_found() {
        let found = exe_origin::image_path_of(std::process::id()).expect("own image path");
        assert!(path_within(&found, &own_exe(), true) && path_within(&own_exe(), &found, true));
    }

    #[test]
    fn an_unknown_pid_has_no_image_path() {
        assert_eq!(exe_origin::image_path_of(0xFFFF_FFF0), None);
    }

    /// No connection pid means no lookup; that is "unknown", never "outside".
    #[tokio::test]
    async fn a_failed_windows_lookup_is_none() {
        let (client, _server, _c) = conn_tests::wired();
        assert_eq!(client.exe_origin.in_payload(Some(Path::new(ROOT)), None), None);
        client.exe_origin.set_server_pid(Some(0xFFFF_FFF0));
        assert_eq!(client.exe_origin.in_payload(Some(Path::new(ROOT)), None), None);
    }

    /// A legacy host has no discovery record at all (`record_pid: None`); its
    /// origin must still be found, through the pid of the live connection.
    #[tokio::test]
    async fn record_less_legacy_host_origin_found_via_connection_pid() {
        let pipe = format!(r"\\.\pipe\tf-origin-{}", uuid::Uuid::new_v4());
        let server = ServerOptions::new().first_pipe_instance(true).create(&pipe).unwrap();
        let accept = tokio::spawn(async move {
            let _ = server.connect().await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });

        let (deps, _c) = conn_tests::deps();
        let no_such_sidecar = std::path::PathBuf::from(r"Z:\no\such\termflow-pty-host.exe");
        let (client, origin) =
            connect_or_spawn(&no_such_sidecar, None, &pipe, "tok", None, deps).await.unwrap();
        assert_eq!(origin, HostConnectionOrigin::Adopted);
        assert_eq!(client.exe_origin.server_pid(), Some(std::process::id()));

        let exe_dir = own_exe().parent().unwrap().to_path_buf();
        let elsewhere = test_dirs::tempdir().unwrap();
        assert_eq!(client.exe_origin.in_payload(Some(&exe_dir), None), Some(true));
        assert_eq!(client.exe_origin.in_payload(Some(elsewhere.path()), None), Some(false));
        assert_eq!(
            client.exe_origin.in_payload(Some(&exe_dir), Some(&exe_dir)),
            Some(false),
            "the runtime dir is explicitly safe"
        );
        client.close_transport().await;
        accept.abort();
    }
}
