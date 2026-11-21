//! IPC-only saved SSH definitions. Events are published while the disk lock is held.
use crate::ssh::store::{ConnectionInput, FolderInput, Persisted, Reply, Store, StoreError};
use crate::ssh::preview::{self, Preview, PreviewError, PreviewSource};
use tauri::{Emitter, State};
pub const CHANGED: &str = "ssh-store:changed";
/// One registration list shared by the real desktop handler and invoke tests.
#[macro_export]
macro_rules! ssh_handlers {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            $crate::commands::ssh_store_get, $crate::commands::ssh_store_reload,
            $crate::commands::ssh_folder_upsert, $crate::commands::ssh_folder_delete,
            $crate::commands::ssh_connection_upsert, $crate::commands::ssh_connection_delete,
            $crate::commands::ssh_move, $crate::commands::ssh_set_bookmark,
            $crate::commands::ssh_forget_secret,
            $crate::commands::ssh_connection_preview, $crate::commands::ssh_connection_mark_used,
            $crate::commands::ssh_session_open, $crate::commands::ssh_session_state,
            $crate::commands::ssh_session_close, $crate::commands::ssh_session_reconnect,
            $crate::commands::ssh_session_submit_secret, $crate::commands::ssh_session_trust_host,
            $crate::commands::ssh_test_connection, $crate::commands::ssh_test_state,
            $crate::commands::ssh_test_close, $crate::commands::ssh_test_submit_secret,
            $crate::commands::ssh_test_trust_host,
            $crate::commands::ssh_fs_list, $crate::commands::ssh_fs_stat,
            $crate::commands::ssh_fs_insert_path,
            $crate::commands::ssh_fs_download,
            $crate::commands::ssh_fs_open,
            $crate::commands::ssh_fs_open_with,
            $crate::commands::ssh_fs_edit_stop,
            $crate::commands::ssh_fs_edit_list,
            $crate::commands::ssh_fs_mkdir, $crate::commands::ssh_fs_create,
            $crate::commands::ssh_fs_rename, $crate::commands::ssh_fs_delete,
            $crate::commands::ssh_fs_chmod, $crate::commands::ssh_fs_chown,
            $($extra),*
        ]
    };
}
pub trait StoreEmitter {
    fn changed(&self, event: &str, reply: &Reply);
}
impl<R: tauri::Runtime> StoreEmitter for tauri::AppHandle<R> {
    fn changed(&self, event: &str, reply: &Reply) {
        if let Err(e) = self.emit(event, reply) {
            log::warn!("SSH store event delivery failed: {e}");
        }
    }
}
fn mutate(
    store: &Store,
    emitter: &impl StoreEmitter,
    operation: impl FnOnce(&mut Persisted) -> Result<(), StoreError>,
) -> Result<Reply, StoreError> {
    store.transact(operation, |reply| emitter.changed(CHANGED, reply))
}
#[tauri::command]
pub fn ssh_store_get(store: State<'_, Store>) -> Result<Reply, StoreError> {
    store.get()
}
#[tauri::command]
pub fn ssh_store_reload<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
) -> Result<Reply, StoreError> {
    store.reload(|reply| app.changed(CHANGED, reply))
}
#[tauri::command]
pub fn ssh_folder_upsert<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    input: FolderInput,
) -> Result<Reply, StoreError> {
    ssh_folder_upsert_inner(&app, &store, input)
}
fn ssh_folder_upsert_inner(
    app: &impl StoreEmitter,
    store: &Store,
    input: FolderInput,
) -> Result<Reply, StoreError> {
    let mut id = None;
    let reply = mutate(store, app, |s| {
        s.upsert_folder(input)?;
        id = s.folders.last().map(|row| row.id.clone());
        Ok(())
    })?;
    log::info!("SSH folder upsert: id={id:?}");
    Ok(reply)
}
#[tauri::command]
pub fn ssh_folder_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    id: String,
    recursive: bool,
) -> Result<Reply, StoreError> {
    ssh_folder_delete_inner(&app, &store, id, recursive)
}
fn ssh_folder_delete_inner(
    app: &impl StoreEmitter,
    store: &Store,
    id: String,
    recursive: bool,
) -> Result<Reply, StoreError> {
    let reply = mutate(store, app, |s| s.delete_folder(&id, recursive))?;
    log::info!("SSH folder delete: id={id}");
    Ok(reply)
}
#[tauri::command]
pub fn ssh_connection_upsert<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    input: ConnectionInput,
) -> Result<Reply, StoreError> {
    ssh_connection_upsert_inner(&app, &store, input)
}
fn ssh_connection_upsert_inner(
    app: &impl StoreEmitter,
    store: &Store,
    input: ConnectionInput,
) -> Result<Reply, StoreError> {
    let mut id = None;
    let reply = mutate(store, app, |s| {
        s.upsert_connection(input)?;
        id = s.connections.last().map(|row| row.id.clone());
        Ok(())
    })?;
    log::info!("SSH connection upsert: id={id:?}");
    Ok(reply)
}
#[tauri::command]
pub fn ssh_connection_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    id: String,
) -> Result<Reply, StoreError> {
    ssh_connection_delete_inner(&app, &store, id)
}
fn ssh_connection_delete_inner(
    app: &impl StoreEmitter,
    store: &Store,
    id: String,
) -> Result<Reply, StoreError> {
    let reply = mutate(store, app, |s| s.delete_connection(&id))?;
    log::info!("SSH connection delete: id={id}");
    Ok(reply)
}
#[tauri::command]
pub fn ssh_move<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    kind: String,
    id: String,
    parent_id: Option<String>,
    index: usize,
) -> Result<Reply, StoreError> {
    ssh_move_inner(&app, &store, kind, id, parent_id, index)
}
fn ssh_move_inner(
    app: &impl StoreEmitter,
    store: &Store,
    kind: String,
    id: String,
    parent_id: Option<String>,
    index: usize,
) -> Result<Reply, StoreError> {
    let reply = mutate(store, app, |s| s.move_row(&kind, &id, parent_id, index))?;
    log::info!("SSH move: kind={kind}, id={id}");
    Ok(reply)
}
#[tauri::command]
pub fn ssh_set_bookmark<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    id: String,
    bookmarked: bool,
) -> Result<Reply, StoreError> {
    ssh_set_bookmark_inner(&app, &store, id, bookmarked)
}
fn ssh_set_bookmark_inner(
    app: &impl StoreEmitter,
    store: &Store,
    id: String,
    bookmarked: bool,
) -> Result<Reply, StoreError> {
    let reply = mutate(store, app, |s| s.set_bookmark(&id, bookmarked))?;
    log::info!("SSH bookmark: id={id}");
    Ok(reply)
}

#[tauri::command]
pub fn ssh_forget_secret<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    id: String,
) -> Result<Reply, StoreError> {
    ssh_forget_secret_inner(&app, &store, id)
}
fn ssh_forget_secret_inner(
    app: &impl StoreEmitter,
    store: &Store,
    id: String,
) -> Result<Reply, StoreError> {
    let reply = mutate(store, app, |s| s.forget_secret(&id))?;
    log::info!("SSH forget saved credential: id={id}");
    Ok(reply)
}

#[tauri::command]
pub fn ssh_connection_preview(
    store: State<'_, Store>,
    source: PreviewSource,
) -> Result<Preview, PreviewError> {
    preview::connection_preview(&store, source)
}

#[tauri::command]
pub fn ssh_connection_mark_used<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    id: String,
) -> Result<Reply, StoreError> {
    mark_used(&app, &store, &id)
}
fn mark_used(app: &impl StoreEmitter, store: &Store, id: &str) -> Result<Reply, StoreError> {
    mutate(store, app, |s| s.mark_used(id))
}

#[cfg(test)]
#[path = "ssh_store_log_tests.rs"]
mod log_tests;
#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, sync::Mutex};
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("tf-ssh-command-{}", uuid::Uuid::new_v4())))
        }
        fn store(&self) -> Store {
            Store::new(self.0.join("ssh.json"))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[derive(Default)]
    struct Capture(Mutex<Vec<(String, Reply)>>);
    impl StoreEmitter for Capture {
        fn changed(&self, event: &str, reply: &Reply) {
            self.0.lock().unwrap().push((event.into(), reply.clone()));
        }
    }
    fn folder() -> FolderInput {
        FolderInput {
            id: None,
            parent_id: None,
            name: "Folder".into(),
            icon: "server".into(),
            color: "sky".into(),
        }
    }
    fn connection() -> ConnectionInput {
        ConnectionInput {
            id: None,
            folder_id: None,
            name: "Host".into(),
            host: "h".into(),
            port: 22,
            user: "u".into(),
            auth: crate::ssh::store::Auth::Agent,
            identity_file: None,
            jump_connection_id: None,
            extra_options: vec![],
            bookmarked: false,
        }
    }
    fn seed_saved_credential(s: &mut Persisted) {
        s.connections[0].auth = crate::ssh::store::Auth::Password;
        s.connections[0].secret = Some("v1:command-test-fixture".into());
    }
    #[test]
    fn every_mutation_command_emits_exactly_ssh_store_changed_with_post_commit_view_and_revision() {
        for kind in [
            "folder_upsert",
            "folder_delete",
            "connection_upsert",
            "connection_delete",
            "move",
            "bookmark",
            "forget",
        ] {
            let temp = Temp::new();
            let store = temp.store();
            let capture = Capture::default();
            let setup = store
                .transact(
                    |s| {
                        s.upsert_folder(folder())?;
                        s.upsert_connection(connection())?;
                        if kind == "forget" {
                            seed_saved_credential(s);
                        }
                        Ok(())
                    },
                    |_| {},
                )
                .unwrap();
            let folder_id = setup.view.folders[0].id.clone();
            let connection_id = setup.view.connections[0].id.clone();
            let reply = match kind {
                "folder_upsert" => ssh_folder_upsert_inner(&capture, &store, folder()),
                "folder_delete" => {
                    ssh_folder_delete_inner(&capture, &store, folder_id.clone(), false)
                }
                "connection_upsert" => ssh_connection_upsert_inner(&capture, &store, connection()),
                "connection_delete" => {
                    ssh_connection_delete_inner(&capture, &store, connection_id.clone())
                }
                "move" => ssh_move_inner(
                    &capture,
                    &store,
                    "connection".into(),
                    connection_id.clone(),
                    Some(folder_id.clone()),
                    0,
                ),
                "bookmark" => ssh_set_bookmark_inner(&capture, &store, connection_id.clone(), true),
                "forget" => ssh_forget_secret_inner(&capture, &store, connection_id.clone()),
                _ => unreachable!(),
            }
            .unwrap();
            assert_eq!(reply.revision, setup.revision + 1, "{kind}");
            if kind == "forget" {
                assert!(setup.view.connections[0].has_saved_secret);
                assert!(!reply.view.connections[0].has_saved_secret);
            }
            if kind == "bookmark" {
                assert!(
                    reply
                        .view
                        .connections
                        .iter()
                        .find(|c| c.id == connection_id)
                        .unwrap()
                        .bookmarked
                );
            }
            if kind == "move" {
                assert_eq!(
                    reply
                        .view
                        .connections
                        .iter()
                        .find(|c| c.id == connection_id)
                        .unwrap()
                        .folder_id,
                    Some(folder_id)
                );
            }
            assert_eq!(reply, store.reload(|_| {}).unwrap(), "{kind}");
            assert_eq!(
                *capture.0.lock().unwrap(),
                vec![("ssh-store:changed".into(), reply.clone())],
                "{kind}"
            );
            assert!(serde_json::to_value(reply).unwrap()["view"]["connections"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c.get("secret").is_none()));
        }
    }
    #[test]
    fn mark_used_locked_reload_preserves_concurrent_bookmark_and_editor_save() {
        let temp = Temp::new();
        let recent = temp.store();
        let editor = temp.store();
        let capture = Capture::default();
        let initial = recent.transact(|s| s.upsert_connection(connection()), |_| {}).unwrap();
        let id = initial.view.connections[0].id.clone();

        // Keep Recent's independent cache at the old revision while other
        // handles commit the bookmark and editor save.
        let bookmark = ssh_set_bookmark_inner(&Capture::default(), &temp.store(), id.clone(), true).unwrap();
        let mut edit = connection();
        edit.id = Some(id.clone());
        edit.bookmarked = bookmark.view.connections[0].bookmarked;
        edit.host = "edited.test".into();
        let mut expected = editor.snapshot().unwrap();
        expected.upsert_connection(edit.clone()).unwrap();
        let before = chrono::Utc::now().timestamp_millis();
        let (saved, marked) = std::thread::scope(|scope| {
            use std::sync::mpsc::{self, RecvTimeoutError};
            use std::time::Duration;
            let (started, start) = mpsc::channel();
            let (finished, finish) = mpsc::channel();
            let saved = editor.transact(|s| {
                s.upsert_connection(edit.clone())?;
                let (recent, capture, id) = (&recent, &capture, &id);
                scope.spawn(move || {
                    started.send(()).unwrap();
                    finished.send(mark_used(capture, recent, id)).unwrap();
                });
                start.recv().unwrap();
                assert!(matches!(finish.recv_timeout(Duration::from_millis(100)), Err(RecvTimeoutError::Timeout)),
                    "mark-used must wait for the editor's config lock");
                Ok(())
            }, |_| {}).unwrap();
            (saved, finish.recv().unwrap().unwrap())
        });
        let after = chrono::Utc::now().timestamp_millis();
        let timestamp = marked.view.connections[0].last_used_at.unwrap();
        assert!((before..=after).contains(&timestamp));
        assert_eq!(marked.revision, saved.revision + 1);
        expected.revision = saved.revision + 1;
        expected.connections[0].last_used_at = Some(timestamp.to_string());
        let bytes = std::fs::read(temp.0.join("ssh.json")).unwrap();
        assert_eq!(bytes, serde_json::to_vec_pretty(&expected).unwrap());
        assert_eq!(marked, expected.view(None));
        assert_eq!(*capture.0.lock().unwrap(), vec![(CHANGED.into(), marked.clone())]);

        // A save submitted without backend-owned fields keeps the usage.
        edit.name = "Another edit".into();
        let resaved = ssh_connection_upsert_inner(&Capture::default(), &editor, edit).unwrap();
        assert_eq!(resaved.view.connections[0].last_used_at, Some(timestamp));
    }

    #[test]
    fn mark_used_failed_write_emits_no_new_revision() {
        let temp = Temp::new();
        let store = temp.store().failing_writer();
        let saved = temp.store().transact(|s| s.upsert_connection(connection()), |_| {}).unwrap();
        assert_eq!(store.get().unwrap(), saved);
        let file = temp.0.join("ssh.json");
        let bytes = std::fs::read(&file).unwrap();
        let capture = Capture::default();
        assert_eq!(mark_used(&capture, &store, &saved.view.connections[0].id).unwrap_err().code, "io");
        assert!(capture.0.lock().unwrap().is_empty());
        assert_eq!(store.get().unwrap(), saved);
        assert_eq!(store.reload(|_| panic!("unchanged reload emitted")).unwrap(), saved);
        assert_eq!(std::fs::read(file).unwrap(), bytes);
    }

    #[test]
    fn refused_and_failed_mutations_emit_nothing() {
        let temp = Temp::new();
        let store = temp.store();
        let capture = Capture::default();
        assert_eq!(
            mutate(&store, &capture, |s| s.delete_connection("absent"))
                .unwrap_err()
                .code,
            "not-found"
        );
        std::fs::write(temp.0.join("ssh.json"), b"broken").unwrap();
        assert_eq!(
            mutate(&store, &capture, |s| s.upsert_folder(folder()))
                .unwrap_err()
                .code,
            "store-read-only"
        );
        assert!(capture.0.lock().unwrap().is_empty());
    }

    #[cfg(all(feature = "integration-tests", not(windows)))]
    #[test]
    fn commands_are_registered() {
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets};
        let temp = Temp::new();
        let app = mock_builder()
            .manage(temp.store())
            .invoke_handler(crate::ssh_handlers![])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let invoke = |cmd: &str, body: serde_json::Value| {
            get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .unwrap()
            .deserialize::<Reply>()
            .unwrap()
        };
        for cmd in [
            "ssh_session_open", "ssh_session_state", "ssh_session_close", "ssh_session_reconnect",
            "ssh_session_submit_secret", "ssh_session_trust_host", "ssh_test_connection",
            "ssh_test_state", "ssh_test_close", "ssh_test_submit_secret", "ssh_test_trust_host",
            "ssh_connection_preview", "ssh_connection_mark_used",
        ] {
            let error = get_ipc_response(&window, tauri::webview::InvokeRequest {
                cmd: cmd.into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(), body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
            }).unwrap_err();
            assert!(!error.to_string().contains("not found"), "unregistered {cmd}: {error}");
        }
        assert_eq!(invoke("ssh_store_get", serde_json::json!({})).revision, 0);
        let reply = invoke(
            "ssh_folder_upsert",
            serde_json::json!({"input":{"parentId":null,"name":"IPC folder","icon":"server","color":"amber"}}),
        );
        assert_eq!(reply.revision, 1);
        assert_eq!(reply.view.folders.len(), 1);
        assert_eq!(reply.view.folders[0].name, "IPC folder");
        assert_eq!(invoke("ssh_store_get", serde_json::json!({})), reply);
        let folder_id = reply.view.folders[0].id.clone();
        let created = invoke(
            "ssh_connection_upsert",
            serde_json::json!({"input": connection()}),
        );
        let id = created.view.connections[0].id.clone();
        let moved = invoke(
            "ssh_move",
            serde_json::json!({"kind":"connection","id":id,"parentId":folder_id,"index":0}),
        );
        assert_eq!(
            moved.view.connections[0].folder_id.as_deref(),
            Some(folder_id.as_str())
        );
        temp.store()
            .transact(
                |s| {
                    seed_saved_credential(s);
                    Ok(())
                },
                |_| {},
            )
            .unwrap();
        let bookmarked = invoke(
            "ssh_set_bookmark",
            serde_json::json!({"id":id,"bookmarked":true}),
        );
        assert!(bookmarked.view.connections[0].bookmarked);
        assert!(bookmarked.view.connections[0].has_saved_secret);
        let forgotten = invoke("ssh_forget_secret", serde_json::json!({"id":id}));
        assert_eq!(forgotten.revision, bookmarked.revision + 1);
        assert!(!forgotten.view.connections[0].has_saved_secret);
        let deleted = invoke("ssh_connection_delete", serde_json::json!({"id":id}));
        assert!(deleted.view.connections.is_empty());
        let deleted = invoke(
            "ssh_folder_delete",
            serde_json::json!({"id":folder_id,"recursive":false}),
        );
        assert!(deleted.view.folders.is_empty());
        let revision = deleted.revision;
        // Exercise the actual Reload adapter/emitter, not just the Store seam.
        use tauri::Listener;
        let events = std::sync::Arc::new(Mutex::new(Vec::<Reply>::new()));
        let captured = events.clone();
        app.listen(CHANGED, move |event| {
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
        let file = temp.0.join("ssh.json");
        let repaired_bytes = std::fs::read(&file).unwrap();
        std::fs::write(&file, b"corrupt").unwrap();
        let read_only = invoke("ssh_store_reload", serde_json::json!({}));
        assert_eq!(read_only.revision, revision + 1);
        assert!(read_only.view.load_error.is_some());
        std::fs::write(&file, repaired_bytes).unwrap(); // old disk revision 1
        let recovered = invoke("ssh_store_reload", serde_json::json!({}));
        assert_eq!(recovered.revision, revision + 2);
        assert!(recovered.view.load_error.is_none());
        assert_eq!(*events.lock().unwrap(), vec![read_only, recovered.clone()]);
        assert_eq!(invoke("ssh_store_reload", serde_json::json!({})), recovered);
        assert_eq!(events.lock().unwrap().len(), 2);
    }
}
