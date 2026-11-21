use super::*;
use crate::ssh::{session::SessionState, tests::Fixture};
use std::{fs, path::{Path, PathBuf}};

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tf-fs-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn fixture(&self) -> Fixture {
        Fixture::with_sftp_root(self.0.clone())
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }

    fn root(&self) -> &Path {
        &self.0
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn generation(f: &Fixture) -> u64 {
    let state = f.registry.state("tm-a", false).unwrap();
    assert_eq!(state.state, SessionState::Connected);
    state.generation
}

fn browser(f: &Fixture) -> RemoteFs<'_> {
    RemoteFs::new(&f.registry, "tm-a", generation(f))
}

#[tokio::test]
async fn fs_primitives_confirm_exact_target() {
    let tree = Tree::new();
    fs::create_dir(tree.path("etc")).unwrap();
    fs::write(tree.path("etc/a"), b"target").unwrap();
    fs::write(tree.path("etc/ab"), b"sibling").unwrap();
    let assert_sibling = || {
        assert_eq!(fs::read(tree.path("etc/ab")).unwrap(), b"sibling");
        assert_eq!(fs::metadata(tree.path("etc/ab")).unwrap().len(), 7);
    };
    let f = tree.fixture();
    f.connected().await;
    let client = browser(&f);
    assert_eq!(client.list(".").await.unwrap().path, "/");
    let listing = client.list("/etc").await.unwrap();
    assert_eq!(listing.session_generation, generation(&f));
    assert_eq!(listing.entries.len(), 2);
    let touched = listing.entries.iter().find(|e| e.path == "/etc/a").unwrap();
    assert_eq!(touched.size, Some("6".into()));
    assert_eq!(touched.kind, RemoteKind::File);
    assert_eq!(fs::read(tree.path("etc/a")).unwrap(), b"target");
    assert_sibling();

    let stat = client.stat("/etc/a").await.unwrap();
    assert_eq!(&stat.entry, touched);
    assert_eq!(stat.entry.size, Some(fs::metadata(tree.path("etc/a")).unwrap().len().to_string()));
    assert!(stat.link_target.is_none());
    assert_sibling();

    client.mkdir("/etc/dir").await.unwrap();
    assert!(fs::metadata(tree.path("etc/dir")).unwrap().is_dir());
    assert_sibling();

    client.create("/etc/empty").await.unwrap();
    assert_eq!(fs::read(tree.path("etc/empty")).unwrap(), b"");
    assert!(f.server.sftp_faults.lock().requests.iter().any(|(op, path)| op == "close" && path == "/etc/empty"));
    assert_sibling();

    client.rename("/etc/a", "/etc/dir/a").await.unwrap();
    assert!(!tree.path("etc/a").exists());
    assert_eq!(fs::read(tree.path("etc/dir/a")).unwrap(), b"target");
    assert_sibling();
    f.registry.shutdown().await;
}

#[tokio::test]
async fn create_existing_never_truncates() {
    let tree = Tree::new();
    fs::write(tree.path("file"), b"keep").unwrap();
    let f = tree.fixture();
    f.connected().await;
    let err = browser(&f).create("/file").await.unwrap_err();
    assert_eq!((err.code, err.outcome, err.path.as_str()), (FsCode::Exists, FsOutcome::Unchanged, "/file"));
    assert_eq!(fs::read(tree.path("file")).unwrap(), b"keep");
    f.registry.shutdown().await;
}

#[tokio::test]
async fn rename_existing_refused() {
    let tree = Tree::new();
    fs::write(tree.path("source"), b"source").unwrap();
    fs::write(tree.path("dest"), b"dest").unwrap();
    let f = tree.fixture();
    f.connected().await;
    let client = browser(&f);
    let err = client.rename("/source", "/dest").await.unwrap_err();
    assert_eq!((err.code, err.outcome, err.path.as_str()), (FsCode::Exists, FsOutcome::Unchanged, "/dest"));
    assert_eq!(fs::read(tree.path("source")).unwrap(), b"source");
    assert_eq!(fs::read(tree.path("dest")).unwrap(), b"dest");

    // Also exercise the server-side refusal when the preflight already passed.
    fs::remove_file(tree.path("dest")).unwrap();
    let dest = tree.path("dest");
    f.server.sftp_faults.lock().before = Some(Box::new(move |op, path| {
        if (op, path) == ("rename", "/source") {
            fs::write(&dest, b"appeared").unwrap();
        }
    }));
    let err = client.rename("/source", "/dest").await.unwrap_err();
    assert_eq!((err.code, err.outcome, err.path.as_str()), (FsCode::Exists, FsOutcome::Unchanged, "/dest"));
    assert_eq!(fs::read(tree.path("source")).unwrap(), b"source");
    assert_eq!(fs::read(tree.path("dest")).unwrap(), b"appeared");
    f.registry.shutdown().await;
}

#[tokio::test]
async fn permission_denied_before_write_reports_unchanged() {
    let tree = Tree::new();
    fs::write(tree.path("source"), b"keep").unwrap();
    let f = tree.fixture();
    f.connected().await;
    f.server.sftp_faults.lock().deny.push(("lstat", "/dest".into()));
    let err = browser(&f).rename("/source", "/dest").await.unwrap_err();
    assert_eq!((err.code, err.outcome, err.path.as_str()), (FsCode::PermissionDenied, FsOutcome::Unchanged, "/dest"));
    assert!(err.message.contains("Nothing was changed"));
    {
        let faults = f.server.sftp_faults.lock();
        let requests: Vec<_> = faults.requests.iter().map(|(o, p)| (o.as_str(), p.as_str())).collect();
        assert_eq!(requests, [("init", ""), ("lstat", "/dest")]);
    }
    assert_eq!(fs::read(tree.path("source")).unwrap(), b"keep");
    assert!(!tree.path("dest").exists());
    f.registry.shutdown().await;
}

#[tokio::test]
async fn disconnect_after_request_reports_unknown_not_success() {
    let tree = Tree::new();
    let f = tree.fixture();
    f.connected().await;
    f.server.sftp_faults.lock().drop_connection_on = Some(("mkdir", "/maybe".into()));
    let err = browser(&f).mkdir("/maybe").await.unwrap_err();
    assert_eq!((err.outcome, err.path.as_str()), (FsOutcome::Unknown, "/maybe"));
    assert!(f.server.sftp_faults.lock().requests.iter().any(|(op, path)| op == "mkdir" && path == "/maybe"));
    assert!(tree.path("maybe").is_dir(), "fixture applied mutation before dropping acknowledgment");
    f.registry.shutdown().await;
}

#[tokio::test]
async fn not_connected_never_opens_sftp() {
    let tree = Tree::new();
    let f = tree.fixture();
    let err = RemoteFs::new(&f.registry, "tm-a", 1).list(".").await.unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::NotConnected, FsOutcome::Unchanged));
    assert_eq!(f.server.counters.subsystems.load(Ordering::SeqCst), 0);
    assert!(f.server.sftp_faults.lock().requests.is_empty());
    f.registry.shutdown().await;
}

#[tokio::test]
async fn remote_paths_do_not_use_windows_join() {
    assert_eq!(child_path("/", "etc").as_deref(), Some("/etc"));
    assert_eq!(child_path("/etc", "a").as_deref(), Some("/etc/a"));
    assert_eq!(child_path("/etc", r"a\b").as_deref(), Some(r"/etc/a\b"));
    for path in ["/", "etc/a", "/etc/../a", "/etc//a", "/a\0b", "/bad\u{fffd}"] {
        assert_eq!(validate("create", path, true).unwrap_err().code, FsCode::InvalidPath);
    }
    let tree = Tree::new();
    fs::create_dir(tree.path("etc")).unwrap();
    let f = tree.fixture();
    f.connected().await;
    let client = browser(&f);
    client.create("/etc/a").await.unwrap();
    assert_eq!(client.list("/etc").await.unwrap().entries[0].path, "/etc/a");
    assert!(f.server.sftp_faults.lock().requests.iter().any(|(op, path)| op == "open" && path == "/etc/a"));
    f.registry.shutdown().await;
}

#[tokio::test]
async fn listing_budget_exceeded_is_unsupported_not_truncated() {
    let tree = Tree::new();
    fs::create_dir(tree.path("over")).unwrap();
    for n in 0..33 {
        fs::write(tree.path(&format!("over/{n}")), b"").unwrap();
    }
    let f = tree.fixture();
    f.connected().await;
    let client = browser(&f);
    // Lower only the budget, not the protocol path. The 33rd item needs
    // a second READDIR packet and must fail the entire listing.
    let err = client.list_bounded("/over", 32).await.unwrap_err();
    assert_eq!((err.code, err.outcome, err.path.as_str()), (FsCode::Unsupported, FsOutcome::Unchanged, "/over"));
    let requests = f.server.sftp_faults.lock().requests.clone();
    assert_eq!(requests.iter().filter(|(op, path)| op == "readdir" && path == "/over").count(), 2);
    assert_eq!(requests.last().map(|(o, p)| (o.as_str(), p.as_str())), Some(("close", "/over")));
    assert_eq!(client.list("/over").await.unwrap().entries.len(), 33);
    let deep = "/d".repeat(MAX_DEPTH + 1);
    let err = client.list(&deep).await.unwrap_err();
    assert_eq!((err.code, err.path.as_str()), (FsCode::Unsupported, deep.as_str()));
    f.registry.shutdown().await;
}

#[tokio::test]
async fn missing_attrs_stay_absent() {
    let tree = Tree::new();
    fs::write(tree.path("file"), b"not zero").unwrap();
    let f = tree.fixture();
    f.connected().await;
    f.server.sftp_faults.lock().omit_attrs = true;
    let client = browser(&f);
    let listing = client.list("/").await.unwrap();
    let stat = client.stat("/file").await.unwrap();
    for entry in [&listing.entries[0], &stat.entry] {
        assert_eq!((entry.size.as_deref(), entry.mtime, entry.atime), (None, None, None));
        let ipc = serde_json::to_value(entry).unwrap();
        assert!(ipc.get("size").is_none() && ipc.get("mtime").is_none());
    }
    f.registry.shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn stat_links_and_keep_unrepresentable_names_non_actionable() {
    use std::{ffi::OsStr, os::unix::{ffi::OsStrExt, fs::symlink}};

    let tree = Tree::new();
    fs::write(tree.path("target"), b"keep").unwrap();
    symlink("target", tree.path("link")).unwrap();
    let invalid = tree.root().join(OsStr::from_bytes(b"bad\xff"));
    fs::write(&invalid, b"invalid-name").unwrap();
    fs::write(tree.path("bad\u{fffd}"), b"valid-but-ambiguous").unwrap();

    let f = tree.fixture();
    f.connected().await;
    let client = browser(&f);
    let stat = client.stat("/link").await.unwrap();
    assert_eq!(stat.entry.kind, RemoteKind::Symlink);
    assert_eq!(stat.link_target.as_deref(), Some("target"));
    let listing = client.list("/").await.unwrap();
    let read_only: Vec<_> = listing.entries.iter().filter(|entry| entry.path.is_empty()).collect();
    assert_eq!(read_only.len(), 2);
    assert!(read_only.iter().all(|entry| entry.name.contains(r"\u{fffd}")));
    for path in ["", "/bad\u{fffd}"] {
        assert_eq!(client.rename(path, "/replacement").await.unwrap_err().code, FsCode::InvalidPath);
    }
    assert_eq!(fs::read(invalid).unwrap(), b"invalid-name");
    assert_eq!(fs::read(tree.path("bad\u{fffd}")).unwrap(), b"valid-but-ambiguous");
    assert!(!tree.path("replacement").exists());
    f.registry.shutdown().await;
}

#[tokio::test]
async fn stale_generation_request_sends_nothing_to_successor() {
    let (a, b) = (Tree::new(), Tree::new());
    fs::write(a.path("sentinel"), b"A").unwrap();
    fs::write(b.path("sentinel"), b"B").unwrap();
    let (f, successor) = (a.fixture(), b.fixture());
    f.connected().await;
    let old = generation(&f);
    let registry = f.registry.clone();
    let (queued, waiting) = tokio::sync::oneshot::channel();
    let (release, go) = tokio::sync::oneshot::channel();
    let action = tokio::spawn(async move {
        let request = RemoteFs::new(&registry, "tm-a", old);
        queued.send(()).unwrap();
        go.await.unwrap();
        request.mkdir("/must-not-exist").await
    });
    waiting.await.unwrap();
    f.registry.close("tm-a", false, Some(old)).unwrap();
    f.use_server_for_next_connection(&successor.server);
    f.connected().await;
    assert_ne!(generation(&f), old);
    assert_eq!(successor.server.counters.handshakes.load(Ordering::SeqCst), 1);
    release.send(()).unwrap();
    let err = action.await.unwrap().unwrap_err();
    assert_eq!((err.code, err.outcome), (FsCode::Stale, FsOutcome::Unchanged));
    assert_eq!(successor.server.counters.subsystems.load(Ordering::SeqCst), 0);
    assert!(successor.server.sftp_faults.lock().requests.is_empty());
    assert!(f.server.sftp_faults.lock().requests.is_empty());
    for (tree, bytes) in [(&a, b"A"), (&b, b"B")] {
        assert_eq!(fs::read(tree.path("sentinel")).unwrap(), bytes);
        assert_eq!(fs::read_dir(tree.root()).unwrap().count(), 1);
    }
    f.registry.shutdown().await;
}
