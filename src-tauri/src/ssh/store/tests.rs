use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("termflow-ssh-{}", uuid::Uuid::new_v4())))
    }
    fn path(&self) -> PathBuf {
        self.0.join("nested/ssh.json")
    }
    fn store(&self) -> Store {
        Store::new(self.path())
    }
    fn put(&self, bytes: &[u8]) {
        std::fs::create_dir_all(self.path().parent().unwrap()).unwrap();
        std::fs::write(self.path(), bytes).unwrap();
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn folder(id: &str, parent: Option<&str>) -> Folder {
    Folder {
        id: id.into(),
        parent_id: parent.map(str::to_owned),
        name: format!("Folder {id}"),
        icon: "server".into(),
        color: "amber".into(),
        order: 0,
    }
}
fn connection(id: &str) -> Connection {
    Connection {
        id: id.into(),
        folder_id: None,
        name: "Production".into(),
        host: "example.test".into(),
        port: 2222,
        user: "deploy".into(),
        auth: Auth::KeyFile,
        identity_file: Some("C:\\k ey".into()),
        jump_connection_id: None,
        extra_options: vec![("ServerAliveInterval".into(), "30".into())],
        bookmarked: true,
        order: 0,
        last_used_at: Some("2026-11-13T00:00:00Z".into()),
        secret: Some("v1:encrypted".into()),
    }
}
fn fixture() -> Persisted {
    Persisted {
        version: 1,
        revision: 17,
        folders: vec![
            folder("f-parent", None),
            folder("f-child", Some("f-parent")),
        ],
        connections: vec![Connection {
            folder_id: Some("f-child".into()),
            ..connection("c-target")
        }],
    }
}
fn input() -> ConnectionInput {
    let mut value = serde_json::to_value(connection("c-target")).unwrap();
    for key in ["id", "order", "lastUsedAt", "secret"] {
        value.as_object_mut().unwrap().remove(key);
    }
    serde_json::from_value(value).unwrap()
}
fn add_folder(data: &mut Persisted, name: &str) -> Result<()> {
    data.upsert_folder(FolderInput {
        id: None,
        parent_id: None,
        name: name.into(),
        icon: "server".into(),
        color: "amber".into(),
    })
}
fn assert_error(error: StoreError, field: &str, code: &str) {
    assert_eq!(error.field.as_deref(), Some(field));
    assert_eq!(error.code, code);
}

#[test]
fn round_trips_every_field() {
    let temp = Temp::new();
    let mut expected = fixture();
    expected.normalize();
    temp.put(&serde_json::to_vec(&expected).unwrap());
    let store = temp.store();
    assert_eq!(store.get().unwrap(), expected.view(None));
    assert_eq!(store.load().unwrap(), expected);
    let result = store
        .transact(
            |s| {
                s.connections[0].bookmarked = false;
                Ok(())
            },
            |_| {},
        )
        .unwrap();
    expected.connections[0].bookmarked = false;
    expected.revision += 1;
    assert_eq!(result, expected.view(None));
    assert_eq!(
        serde_json::from_slice::<Persisted>(&std::fs::read(temp.path()).unwrap()).unwrap(),
        expected
    );
}
#[test]
fn missing_file_is_empty_and_parent_is_created_on_first_write() {
    let temp = Temp::new();
    let store = temp.store();
    assert_eq!(store.get().unwrap(), Persisted::default().view(None));
    assert!(!temp.path().exists());
    store.transact(|s| add_folder(s, "First"), |_| {}).unwrap();
    assert!(temp.path().is_file());
    let data = store.load().unwrap();
    assert_eq!(data.revision, 1);
    assert_eq!(data.folders[0].name, "First");
    assert!(data.folders[0].id.starts_with("f-"));
    assert_eq!(data.folders[0].id.len(), 18);
}
#[test]
fn read_error_other_than_not_found_is_read_only() {
    let temp = Temp::new();
    std::fs::create_dir_all(temp.path()).unwrap();
    let store = temp.store();
    assert_eq!(
        store.get().unwrap().view.load_error.unwrap().code,
        "read-error"
    );
    assert_eq!(
        store
            .transact(|s| add_folder(s, "No"), |_| panic!("must not emit"))
            .unwrap_err()
            .code,
        "store-read-only"
    );
    assert!(temp.path().is_dir());
}
#[test]
fn invalid_utf8_json_error_future_version_each_read_only_and_bytes_unchanged() {
    let mut future = fixture();
    future.version = 2;
    for bytes in [
        vec![0xff, 0xfe],
        b"{no-json".to_vec(),
        serde_json::to_vec(&future).unwrap(),
    ] {
        let temp = Temp::new();
        temp.put(&bytes);
        let store = temp.store();
        assert!(store.get().unwrap().view.load_error.is_some());
        assert_eq!(
            store
                .transact(|s| add_folder(s, "No"), |_| panic!("must not emit"))
                .unwrap_err()
                .code,
            "store-read-only"
        );
        assert_eq!(std::fs::read(temp.path()).unwrap(), bytes);
        temp.put(&serde_json::to_vec(&fixture()).unwrap());
        assert!(store.get().unwrap().view.load_error.is_none());
    }
}
#[test]
fn dangling_parent_folder_jump_refs_and_duplicate_ids_each_read_only() {
    let mut cases = vec![];
    let mut s = fixture();
    s.folders[0].parent_id = Some("missing".into());
    cases.push(s);
    let mut s = fixture();
    s.connections[0].folder_id = Some("missing".into());
    cases.push(s);
    let mut s = fixture();
    s.connections[0].jump_connection_id = Some("missing".into());
    cases.push(s);
    let mut s = fixture();
    s.connections[0].id = s.folders[0].id.clone();
    cases.push(s);
    let mut s = fixture();
    s.folders[0].parent_id = Some("f-child".into());
    cases.push(s);
    for s in cases {
        let temp = Temp::new();
        let bytes = serde_json::to_vec(&s).unwrap();
        temp.put(&bytes);
        let store = temp.store();
        assert!(store.get().unwrap().view.load_error.is_some());
        assert_eq!(
            store
                .transact(|s| add_folder(s, "No"), |_| panic!("must not emit"))
                .unwrap_err()
                .code,
            "store-read-only"
        );
        assert_eq!(std::fs::read(temp.path()).unwrap(), bytes);
    }
}
#[test]
fn failed_write_leaves_file_cache_and_revision_unchanged_and_emits_nothing() {
    for stage in ["write", "rename"] {
        let temp = Temp::new();
        let bytes = serde_json::to_vec(&fixture()).unwrap();
        temp.put(&bytes);
        let mut store = temp.store();
        let before = store.get().unwrap();
        let cache = store.cache.lock().unwrap().clone();
        store.writer = Box::new(move |path, contents| {
            if stage == "rename" {
                let staging = path.with_extension("test-tmp");
                std::fs::write(&staging, contents).unwrap();
                std::fs::remove_file(staging).unwrap();
            }
            Err(format!("injected {stage} failure"))
        });
        let events = AtomicUsize::new(0);
        assert_eq!(
            store
                .transact(
                    |s| add_folder(s, "Never"),
                    |_| {
                        events.fetch_add(1, Ordering::SeqCst);
                    }
                )
                .unwrap_err()
                .code,
            "io"
        );
        assert_eq!(std::fs::read(temp.path()).unwrap(), bytes);
        assert_eq!(*store.cache.lock().unwrap(), cache);
        assert_eq!(store.get().unwrap(), before);
        assert_eq!(events.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn two_store_owners_on_one_path_do_not_lose_updates() {
    let temp = Temp::new();
    let a = temp.store();
    let b = temp.store();
    a.get().unwrap();
    b.get().unwrap();
    a.transact(|s| add_folder(s, "A"), |_| {}).unwrap();
    b.transact(|s| add_folder(s, "B"), |_| {}).unwrap();
    a.transact(|s| add_folder(s, "C"), |_| {}).unwrap();
    let view = b.get().unwrap();
    assert_eq!(view.revision, 3);
    assert_eq!(
        view.view
            .folders
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        vec!["A", "B", "C"]
    );
}
#[test]
fn revision_strictly_increases_per_commit_and_not_on_refusal() {
    let temp = Temp::new();
    let store = temp.store();
    let mut events = vec![];
    for revision in 1..=3 {
        let reply = store
            .transact(|s| add_folder(s, "A"), |r| events.push(r.clone()))
            .unwrap();
        assert_eq!(reply.revision, revision);
        assert_eq!(events.last(), Some(&reply));
    }
    assert_eq!(
        store
            .transact(
                |s| s.delete_connection("absent"),
                |_| panic!("refusal emitted")
            )
            .unwrap_err()
            .code,
        "not-found"
    );
    assert_eq!(store.get().unwrap().revision, 3);
}
#[test]
fn move_checks_deepest_descendant_depth_and_cycles() {
    let temp = Temp::new();
    let mut s = fixture();
    for n in 0..7 {
        s.folders.push(folder(
            &format!("f-deep{n}"),
            if n == 0 { None } else { Some("unused") },
        ));
        if n > 0 {
            s.folders.last_mut().unwrap().parent_id = Some(format!("f-deep{}", n - 1));
        }
    }
    temp.put(&serde_json::to_vec(&s).unwrap());
    let store = temp.store();
    let before = store.get().unwrap();
    assert_error(
        store
            .transact(
                |s| s.move_row("folder", "f-parent", Some("f-deep6".into()), 0),
                |_| panic!(),
            )
            .unwrap_err(),
        "parentId",
        "depth",
    );
    assert_error(
        store
            .transact(
                |s| s.move_row("folder", "f-parent", Some("f-child".into()), 0),
                |_| panic!(),
            )
            .unwrap_err(),
        "parentId",
        "cycle",
    );
    assert_eq!(store.get().unwrap(), before);
}
#[test]
fn nonempty_folder_delete_needs_recursive() {
    let mut s = fixture();
    assert_eq!(
        s.delete_folder("f-parent", false).unwrap_err().code,
        "not-empty"
    );
    s.delete_folder("f-parent", true).unwrap();
    assert!(s.folders.is_empty());
    assert!(s.connections.is_empty());
}
#[test]
fn delete_of_jump_target_is_refused_naming_referrers() {
    let mut s = fixture();
    let mut referrer = connection("c-outside");
    referrer.jump_connection_id = Some("c-target".into());
    referrer.name = "Referrer".into();
    s.connections.push(referrer);
    for error in [
        s.delete_connection("c-target").unwrap_err(),
        s.delete_folder("f-parent", true).unwrap_err(),
    ] {
        assert_eq!(error.code, "in-use-as-jump");
        assert_eq!(error.message, "Referrer (c-outside)");
    }
}
#[test]
fn each_field_rule_rejects_its_bad_input_with_its_field_and_code() {
    type Change = Box<dyn Fn(&mut Persisted)>;
    let mut cases: Vec<(&str, &str, Change)> = vec![
        (
            "name",
            "length",
            Box::new(|s| s.connections[0].name = " ".into()),
        ),
        (
            "name",
            "length",
            Box::new(|s| s.connections[0].name = "x".repeat(81)),
        ),
        (
            "host",
            "required",
            Box::new(|s| s.connections[0].host.clear()),
        ),
        (
            "host",
            "leading-dash",
            Box::new(|s| s.connections[0].host = "-oProxyCommand=x".into()),
        ),
        (
            "host",
            "invalid",
            Box::new(|s| s.connections[0].host = "some host".into()),
        ),
        (
            "host",
            "invalid",
            Box::new(|s| s.connections[0].host = "some\0host".into()),
        ),
        ("port", "range", Box::new(|s| s.connections[0].port = 0)),
        (
            "user",
            "leading-dash",
            Box::new(|s| s.connections[0].user = "-x".into()),
        ),
        (
            "user",
            "invalid",
            Box::new(|s| s.connections[0].user = "user@host".into()),
        ),
        (
            "user",
            "invalid",
            Box::new(|s| s.connections[0].user = "some user".into()),
        ),
        (
            "identityFile",
            "required",
            Box::new(|s| s.connections[0].identity_file = None),
        ),
        (
            "identityFile",
            "not-applicable",
            Box::new(|s| s.connections[0].auth = Auth::Agent),
        ),
        (
            "extraOptions",
            "too-many",
            Box::new(|s| s.connections[0].extra_options = vec![("Foo".into(), "bar".into()); 33]),
        ),
        (
            "extraOptions",
            "invalid-key",
            Box::new(|s| s.connections[0].extra_options = vec![("Bad1".into(), "x".into())]),
        ),
        (
            "extraOptions",
            "invalid-value",
            Box::new(|s| {
                s.connections[0].extra_options = vec![("Compression".into(), "a\nb".into())]
            }),
        ),
        (
            "extraOptions",
            "invalid-value",
            Box::new(|s| {
                s.connections[0].extra_options = vec![("Compression".into(), "a\0b".into())]
            }),
        ),
        (
            "jumpConnectionId",
            "self",
            Box::new(|s| s.connections[0].jump_connection_id = Some("c-target".into())),
        ),
        (
            "icon",
            "invalid",
            Box::new(|s| s.folders[0].icon = "invalid".into()),
        ),
        (
            "color",
            "invalid",
            Box::new(|s| s.folders[0].color = "invalid".into()),
        ),
    ];
    for key in [
        "HostName",
        "Port",
        "User",
        "IdentityFile",
        "ProxyJump",
        "ProxyCommand",
        "StrictHostKeyChecking",
        "UserKnownHostsFile",
        "GlobalKnownHostsFile",
        "KnownHostsCommand",
        "HostKeyAlias",
        "LocalCommand",
        "PermitLocalCommand",
        "RemoteCommand",
        "SessionType",
        "UnknownOption",
        "hostname",
        "PROXYCOMMAND",
        "proxyJump",
        "proxycommand",
    ] {
        cases.push((
            "extraOptions",
            "option-not-allowed",
            Box::new(move |s| s.connections[0].extra_options = vec![(key.into(), "x".into())]),
        ));
    }
    for key in ALLOWED_OPTIONS.iter().copied().chain([
        "serveraliveinterval",
        "COMPRESSION",
        "localForward",
    ]) {
        let mut s = fixture();
        s.connections[0].extra_options = vec![(key.into(), "value".into())];
        s.validate().unwrap();
    }
    for (field, code, change) in cases {
        let mut s = fixture();
        change(&mut s);
        assert_error(s.validate().unwrap_err(), field, code);
    }
    for host in ["::1", "[::1]", "2001:db8::1", "[2001:db8::1]"] {
        let mut s = fixture();
        s.connections[0].host = host.into();
        s.validate().unwrap();
    }
}
#[test]
fn input_cannot_set_secret_last_used_order_or_revision() {
    for (key, value) in [
        ("secret", serde_json::json!("v1:bad")),
        ("lastUsedAt", serde_json::json!("now")),
        ("order", serde_json::json!(12)),
        ("revision", serde_json::json!(9)),
    ] {
        let mut json = serde_json::to_value(input()).unwrap();
        json[key] = value.clone();
        assert!(
            serde_json::from_value::<ConnectionInput>(json).is_err(),
            "{key}"
        );
        let mut json = serde_json::json!({"name":"Folder", "icon":"folder", "color":"grey"});
        json[key] = value;
        assert!(
            serde_json::from_value::<FolderInput>(json).is_err(),
            "{key}"
        );
    }
}
#[test]
fn view_never_contains_secret_and_reports_has_saved_secret() {
    let mut s = fixture();
    let view = s.view(None);
    assert!(view.view.connections[0].has_saved_secret);
    let json = serde_json::to_value(view).unwrap();
    assert!(json["view"]["connections"][0].get("secret").is_none());
    assert!(!json.to_string().contains("encrypted"));
    s.connections[0].secret = None;
    assert!(!s.view(None).view.connections[0].has_saved_secret);
}
#[test]
fn resolve_returns_target_and_jump_hops_in_order_with_their_own_auth() {
    let mut s = fixture();
    s.connections[0].jump_connection_id = Some("c-jump".into());
    let jump = Connection {
        id: "c-jump".into(),
        host: "bastion".into(),
        port: 2200,
        user: "jump-user".into(),
        auth: Auth::Agent,
        identity_file: None,
        ..connection("unused")
    };
    s.connections.push(jump);
    let resolved = crate::ssh::target::resolve(&s, "c-target").unwrap();
    assert_eq!(
        resolved,
        crate::ssh::target::ResolvedTarget {
            hops: vec![
                crate::ssh::target::Hop {
                    connection_id: "c-jump".into(),
                    host: "bastion".into(),
                    port: 2200,
                    user: "jump-user".into(),
                    auth: Auth::Agent,
                    identity_file: None
                },
                crate::ssh::target::Hop {
                    connection_id: "c-target".into(),
                    host: "example.test".into(),
                    port: 2222,
                    user: "deploy".into(),
                    auth: Auth::KeyFile,
                    identity_file: Some("C:\\k ey".into())
                }
            ],
            extra_options: vec![("ServerAliveInterval".into(), "30".into())]
        }
    );
}
#[test]
fn path_is_dev_file_scoped_once() {
    assert_eq!(
        store_path().file_name().unwrap().to_str().unwrap(),
        crate::app_config::dev_file("ssh_connections.json")
    );
    assert_eq!(
        store_path().parent().unwrap().file_name().unwrap(),
        ".auto-terminal"
    );
    use crate::profile::{Integrity, ProfileIdentity};
    for (channel, name, integrity, base, expected) in [
        (
            "rel",
            "default",
            Integrity::Medium,
            "ssh_connections.json",
            "ssh_connections.json",
        ),
        (
            "rel",
            "work",
            Integrity::Medium,
            "ssh_connections.json",
            "ssh_connections.work.json",
        ),
        (
            "dev",
            "default",
            Integrity::Medium,
            "ssh_connections.dev.json",
            "ssh_connections.dev.json",
        ),
        (
            "rel",
            "default",
            Integrity::High,
            "ssh_connections.json",
            "ssh_connections.high.json",
        ),
        (
            "rel",
            "work",
            Integrity::High,
            "ssh_connections.json",
            "ssh_connections.work.high.json",
        ),
    ] {
        let identity = ProfileIdentity {
            channel,
            name: name.into(),
            integrity,
        };
        assert_eq!(identity.scoped_file(base), expected);
    }
}
