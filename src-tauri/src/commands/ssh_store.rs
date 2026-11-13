//! IPC-only saved SSH definitions. Events are published while the disk lock is held.
use crate::ssh::store::{ConnectionInput, FolderInput, Persisted, Reply, Store, StoreError};
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
    log::info!("SSH folder upsert: id={:?}", input.id);
    mutate(&store, &app, |s| s.upsert_folder(input))
}
#[tauri::command]
pub fn ssh_folder_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    id: String,
    recursive: bool,
) -> Result<Reply, StoreError> {
    log::info!("SSH folder delete: id={id}");
    mutate(&store, &app, |s| s.delete_folder(&id, recursive))
}
#[tauri::command]
pub fn ssh_connection_upsert<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    input: ConnectionInput,
) -> Result<Reply, StoreError> {
    log::info!("SSH connection upsert: id={:?}", input.id);
    mutate(&store, &app, |s| s.upsert_connection(input))
}
#[tauri::command]
pub fn ssh_connection_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    id: String,
) -> Result<Reply, StoreError> {
    log::info!("SSH connection delete: id={id}");
    mutate(&store, &app, |s| s.delete_connection(&id))
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
    log::info!("SSH move: kind={kind}, id={id}, parent={parent_id:?}");
    mutate(&store, &app, |s| s.move_row(&kind, &id, parent_id, index))
}
#[tauri::command]
pub fn ssh_set_bookmark<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    store: State<'_, Store>,
    id: String,
    bookmarked: bool,
) -> Result<Reply, StoreError> {
    log::info!("SSH bookmark: id={id}");
    mutate(&store, &app, |s| s.set_bookmark(&id, bookmarked))
}

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
    #[test]
    fn every_mutation_command_emits_exactly_ssh_store_changed_with_post_commit_view_and_revision() {
        // The command table has six mutations (eight commands minus get/reload).
        for kind in [
            "folder_upsert",
            "folder_delete",
            "connection_upsert",
            "connection_delete",
            "move",
            "bookmark",
        ] {
            let temp = Temp::new();
            let store = temp.store();
            let capture = Capture::default();
            let setup = store
                .transact(
                    |s| {
                        s.upsert_folder(folder())?;
                        s.upsert_connection(connection())
                    },
                    |_| {},
                )
                .unwrap();
            let folder_id = setup.view.folders[0].id.clone();
            let connection_id = setup.view.connections[0].id.clone();
            let reply = mutate(&store, &capture, |s| match kind {
                "folder_upsert" => s.upsert_folder(folder()),
                "folder_delete" => s.delete_folder(&folder_id, false),
                "connection_upsert" => s.upsert_connection(connection()),
                "connection_delete" => s.delete_connection(&connection_id),
                "move" => s.move_row("connection", &connection_id, Some(folder_id), 0),
                "bookmark" => s.set_bookmark(&connection_id, true),
                _ => unreachable!(),
            })
            .unwrap();
            assert_eq!(reply.revision, setup.revision + 1, "{kind}");
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
        assert_eq!(invoke("ssh_store_get", serde_json::json!({})).revision, 0);
        let reply = invoke(
            "ssh_folder_upsert",
            serde_json::json!({"input":{"parentId":null,"name":"IPC folder","icon":"server","color":"amber"}}),
        );
        assert_eq!(reply.revision, 1);
        assert_eq!(reply.view.folders.len(), 1);
        assert_eq!(reply.view.folders[0].name, "IPC folder");
        assert_eq!(invoke("ssh_store_get", serde_json::json!({})), reply);
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
        assert_eq!(read_only.revision, 2);
        assert!(read_only.view.load_error.is_some());
        std::fs::write(&file, repaired_bytes).unwrap(); // old disk revision 1
        let recovered = invoke("ssh_store_reload", serde_json::json!({}));
        assert_eq!(recovered.revision, 3);
        assert!(recovered.view.load_error.is_none());
        assert_eq!(*events.lock().unwrap(), vec![read_only, recovered.clone()]);
        assert_eq!(invoke("ssh_store_reload", serde_json::json!({})), recovered);
        assert_eq!(events.lock().unwrap().len(), 2);
    }
}
