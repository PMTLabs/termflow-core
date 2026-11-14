use super::*;
use std::sync::Mutex;
struct Logs(Mutex<Vec<String>>);
static LOGS: Logs = Logs(Mutex::new(Vec::new()));
impl log::Log for Logs {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        if record.target().ends_with("commands::ssh_store") && record.level() == log::Level::Info {
            self.0.lock().unwrap().push(record.args().to_string());
        }
    }
    fn flush(&self) {}
}
#[test]
fn ssh_mutation_logs_are_success_only_and_contain_only_kind_and_ids() {
    const CHILD: &str = "TF_SSH_LOG_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        assert!(std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","commands::ssh_store::log_tests::ssh_mutation_logs_are_success_only_and_contain_only_kind_and_ids","--nocapture"]).env(CHILD,"1").status().unwrap().success());
        return;
    }
    log::set_logger(&LOGS).unwrap();
    log::set_max_level(log::LevelFilter::Info);
    let path = std::env::temp_dir().join(format!("tf-ssh-log-{}", uuid::Uuid::new_v4()));
    let store = Store::new(path.join("ssh.json"));
    struct Quiet;
    impl StoreEmitter for Quiet {
        fn changed(&self, _: &str, _: &Reply) {}
    }
    let folder = ssh_folder_upsert_inner(
        &Quiet,
        &store,
        FolderInput {
            id: None,
            parent_id: None,
            name: "private-folder-name".into(),
            icon: "folder".into(),
            color: "grey".into(),
        },
    )
    .unwrap()
    .view
    .folders[0]
        .id
        .clone();
    let connection = ssh_connection_upsert_inner(
        &Quiet,
        &store,
        ConnectionInput {
            id: None,
            folder_id: None,
            name: "private-name".into(),
            host: "private-host".into(),
            user: "private-user".into(),
            port: 22,
            auth: crate::ssh::store::Auth::Agent,
            identity_file: None,
            jump_connection_id: None,
            extra_options: vec![],
            bookmarked: false,
        },
    )
    .unwrap()
    .view
    .connections[0]
        .id
        .clone();
    ssh_move_inner(
        &Quiet,
        &store,
        "connection".into(),
        connection.clone(),
        Some(folder.clone()),
        0,
    )
    .unwrap();
    ssh_set_bookmark_inner(&Quiet, &store, connection.clone(), true).unwrap();
    ssh_connection_delete_inner(&Quiet, &store, connection.clone()).unwrap();
    ssh_folder_delete_inner(&Quiet, &store, folder.clone(), false).unwrap();
    assert!(ssh_connection_delete_inner(&Quiet, &store, "missing".into()).is_err());
    assert_eq!(
        *LOGS.0.lock().unwrap(),
        vec![
            format!("SSH folder upsert: id={:?}", Some(&folder)),
            format!("SSH connection upsert: id={:?}", Some(&connection)),
            format!("SSH move: kind=connection, id={connection}"),
            format!("SSH bookmark: id={connection}"),
            format!("SSH connection delete: id={connection}"),
            format!("SSH folder delete: id={folder}"),
        ]
    );
    let _ = std::fs::remove_dir_all(path);
}
