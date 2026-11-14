use super::*;

#[test]
fn every_persisted_string_has_bounds_and_control_or_allowlist_validation() {
    // JSON editing exercises the load-time validator, not input-only normalization.
    let fields = [
        ("folders", "id", "id", 64),
        ("folders", "parentId", "parentId", 64),
        ("folders", "name", "name", 80),
        ("connections", "id", "id", 64),
        ("connections", "folderId", "folderId", 64),
        ("connections", "jumpConnectionId", "jumpConnectionId", 64),
        ("connections", "name", "name", 80),
        ("connections", "host", "host", 255),
        ("connections", "user", "user", 128),
        ("connections", "identityFile", "identityFile", 4096),
        ("connections", "lastUsedAt", "lastUsedAt", 64),
        ("connections", "secret", "secret", 16384),
        ("connections", "extraOptions", "extraOptions", 1024),
    ];
    for (kind, key, field, max) in fields {
        for (value, code) in [
            ("x".repeat(max + 1), "length"),
            (
                "a\0b".into(),
                if key == "extraOptions" {
                    "invalid-value"
                } else {
                    "invalid"
                },
            ),
            (
                "a\rb".into(),
                if key == "extraOptions" {
                    "invalid-value"
                } else {
                    "invalid"
                },
            ),
            (
                "a\nb".into(),
                if key == "extraOptions" {
                    "invalid-value"
                } else {
                    "invalid"
                },
            ),
        ] {
            let mut json = serde_json::to_value(fixture()).unwrap();
            if key == "extraOptions" {
                json[kind][0][key] = serde_json::json!([["SetEnv", value]]);
            } else {
                json[kind][0][key] = value.into();
            }
            let data: Persisted = serde_json::from_value(json).unwrap();
            assert_error(data.validate().unwrap_err(), field, code);
        }
        let value = "x".repeat(max);
        let mut json = serde_json::to_value(fixture()).unwrap();
        if key == "extraOptions" {
            json[kind][0][key] = serde_json::json!([["SetEnv", value]]);
        } else {
            json[kind][0][key] = value.clone().into();
        }
        // Keep references valid when testing at-bound ids and references.
        match (kind, key) {
            ("folders", "id") => json["folders"][1]["parentId"] = value.into(),
            ("folders", "parentId") => {
                json["folders"][0]["parentId"] = value.clone().into();
                json["folders"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::to_value(folder(&value, None)).unwrap());
            }
            ("connections", "folderId") => json["folders"][1]["id"] = value.into(),
            ("connections", "jumpConnectionId") => json["connections"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::to_value(connection(&value)).unwrap()),
            _ => {}
        }
        let data: Persisted = serde_json::from_value(json).unwrap();
        data.validate()
            .unwrap_or_else(|e| panic!("{kind}.{key} at bound: {e:?}"));
    }
    for id in ["", "bad/id", "bad.id", "é", "x@y"] {
        for (kind, key) in [
            ("folders", "id"),
            ("folders", "parentId"),
            ("connections", "id"),
            ("connections", "folderId"),
            ("connections", "jumpConnectionId"),
        ] {
            let mut json = serde_json::to_value(fixture()).unwrap();
            json[kind][0][key] = id.into();
            let data: Persisted = serde_json::from_value(json).unwrap();
            assert_error(data.validate().unwrap_err(), key, "invalid");
        }
    }
    for prefix in ["f", "c"] {
        identifier(&new_id(prefix), "id").unwrap();
    }
    // Names use raw stored character length, not trimmed length or byte length.
    let mut data = fixture();
    data.folders[0].name = format!("{}x", " ".repeat(80));
    assert_error(data.validate().unwrap_err(), "name", "length");
    data.folders[0].name = "é".repeat(80);
    data.validate().unwrap();
}

#[test]
fn host_allowlist_and_canonical_ipv6_cover_load_write_view_and_resolver() {
    for host in [
        "ssh://a@evil:2222",
        "bob@evil",
        "a/b",
        "[::1",
        "::1]",
        "[[::1]]",
        "[host]",
        "a:22",
        ".host",
        "a;b",
        "a\\b",
        "a$b",
        "é",
        "[x:y]",
        "a b",
        "a\0b",
    ] {
        let mut data = fixture();
        data.connections[0].host = host.into();
        assert_error(data.validate().unwrap_err(), "host", "invalid");
        let temp = Temp::new();
        temp.put(&serde_json::to_vec(&data).unwrap());
        assert!(temp.store().get().unwrap().view.load_error.is_some());
    }
    for host in ["host_1.example", "127.0.0.1", "::1", "[2001:db8::1]"] {
        let mut data = fixture();
        data.connections[0].host = host.into();
        data.validate().unwrap();
    }
    let temp = Temp::new();
    let store = temp.store();
    let mut i = input();
    i.host = "[2001:db8::1]".into();
    let reply = store.transact(|s| s.upsert_connection(i), |_| {}).unwrap();
    assert_eq!(reply.view.connections[0].host, "2001:db8::1");
    let data = store.load().unwrap();
    assert_eq!(data.connections[0].host, "2001:db8::1");
    assert_eq!(
        crate::ssh::target::resolve(&data, &data.connections[0].id)
            .unwrap()
            .hops[0]
            .host,
        "2001:db8::1"
    );
    let mut data = fixture();
    data.connections[0].host = "[::1]".into();
    assert_eq!(
        crate::ssh::target::resolve(&data, "c-target").unwrap().hops[0].host,
        "::1"
    );
}

#[test]
fn upserts_preserve_owned_fields_and_append_on_parent_change() {
    let mut data = fixture();
    data.connections[0].order = 7;
    data.folders[1].order = 4;
    let mut i = input();
    i.id = Some("c-target".into());
    i.folder_id = Some("f-child".into());
    i.name = " Updated ".into();
    data.upsert_connection(i.clone()).unwrap();
    assert_eq!(data.connections[0].name, "Updated");
    assert_eq!(data.connections[0].secret, connection("x").secret);
    assert_eq!(
        data.connections[0].last_used_at,
        connection("x").last_used_at
    );
    assert_eq!(data.connections[0].order, 7);
    let mut f = FolderInput {
        id: Some("f-child".into()),
        parent_id: Some("f-parent".into()),
        name: " Renamed ".into(),
        icon: "cloud".into(),
        color: "sky".into(),
    };
    data.upsert_folder(f.clone()).unwrap();
    assert_eq!(data.folders[1].order, 4);
    assert_eq!(data.folders[1].name, "Renamed");
    f.parent_id = None;
    data.upsert_folder(f.clone()).unwrap();
    assert_eq!(data.folders[1].order, 1);
    i.folder_id = None;
    data.upsert_connection(i.clone()).unwrap();
    assert_eq!(data.connections[0].order, 2);
    i.id = None;
    data.upsert_connection(i.clone()).unwrap();
    assert_eq!(data.connections.len(), 2);
    assert_eq!(data.connections[1].order, 3);
    assert_eq!(data.connections[1].secret, None);
    assert_eq!(data.connections[1].last_used_at, None);
    f.id = None;
    data.upsert_folder(f.clone()).unwrap();
    assert_eq!(data.folders.len(), 3);
    assert_eq!(data.folders[2].order, 4);
    i.id = Some("missing".into());
    assert_eq!(
        data.upsert_connection(i.clone()).unwrap_err().code,
        "not-found"
    );
    f.id = Some("missing".into());
    assert_eq!(data.upsert_folder(f).unwrap_err().code, "not-found");
    for port in [-1, 0, 70000, i64::MAX] {
        i.id = None;
        i.port = port;
        assert_error(
            data.upsert_connection(i.clone()).unwrap_err(),
            "port",
            "range",
        );
    }
    let mut data = fixture();
    let mut jump = connection("jump");
    jump.jump_connection_id = Some("c-target".into());
    data.connections.push(jump);
    let mut i = input();
    i.jump_connection_id = Some("jump".into());
    data.upsert_connection(i).unwrap();
    assert_error(data.validate().unwrap_err(), "jumpConnectionId", "nested");
}

#[test]
fn overlapping_transactions_block_until_commit_and_both_writes_survive() {
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::Duration;
    let temp = Temp::new();
    temp.put(&serde_json::to_vec(&Persisted::default()).unwrap());
    let a = temp.store();
    let b = temp.store();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let (started_tx, started_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let entered_a = entered.clone();
    let release_a = release.clone();
    let ta = std::thread::spawn(move || {
        a.transact(
            |s| {
                entered_a.wait();
                release_a.wait();
                add_folder(s, "A")
            },
            |_| {},
        )
        .unwrap()
    });
    entered.wait();
    let tb = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        let r = b.transact(|s| add_folder(s, "B"), |_| {}).unwrap();
        done_tx.send(()).unwrap();
        r
    });
    started_rx.recv().unwrap();
    let blocked = done_rx.recv_timeout(Duration::from_millis(250)).is_err();
    release.wait();
    ta.join().unwrap();
    tb.join().unwrap();
    assert!(blocked, "B entered while A held the transaction lock");
    let view = temp.store().get().unwrap();
    assert_eq!(view.revision, 2);
    assert_eq!(
        view.view
            .folders
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        vec!["A", "B"]
    );
}

#[test]
fn read_only_mutation_error_carries_store_path() {
    let temp = Temp::new();
    temp.put(b"broken");
    let error = temp
        .store()
        .transact(|s| add_folder(s, "No"), |_| panic!())
        .unwrap_err();
    assert_eq!(error.code, "store-read-only");
    assert!(error
        .message
        .starts_with(&format!("{}: ", temp.path().display())));
}
