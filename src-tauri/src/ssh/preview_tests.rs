use super::*;
use crate::ssh::store::Auth;
use std::fs;

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("tf-preview-{}", uuid::Uuid::new_v4())))
    }
    fn store(&self) -> Store {
        Store::new(self.0.join("ssh.json"))
    }
    fn preview(&self, source: PreviewSource) -> Result<Preview, PreviewError> {
        preview_in(&self.store(), source, || Ok(("/usr/bin/ssh".into(), self.0.join("native home"))))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn input(host: &str) -> ConnectionInput {
    ConnectionInput {
        id: None, folder_id: None, name: "Name".into(), host: host.into(), port: 2222,
        user: "operator".into(), auth: Auth::Agent, identity_file: None,
        jump_connection_id: None, extra_options: vec![("serveraliveinterval".into(), "30".into())],
        bookmarked: false,
    }
}

#[test]
fn preview_saved_and_validated_unsaved_draft_use_rust_builder_without_writes() {
    let temp = Temp::new();
    let first = temp.preview(PreviewSource::Draft { draft: Box::new(input("new.test")), editing_id: None }).unwrap();
    assert_eq!(first.store_revision, 0);
    assert!(!temp.0.exists(), "preview must not create config, lock, or helper files");

    let store = temp.store();
    let saved = store.transact(|s| s.upsert_connection(input("saved.test")), |_| {}).unwrap();
    let id = saved.view.connections[0].id.clone();
    let file = temp.0.join("ssh.json");
    let bytes = fs::read(&file).unwrap();
    let preview = temp.preview(PreviewSource::Saved { id: id.clone() }).unwrap();
    assert_eq!(preview.store_revision, saved.revision);
    assert_eq!(&preview.argv[..3], &["/usr/bin/ssh", "-F", "none"]);
    assert!(preview.argv.iter().any(|a| a.starts_with("UserKnownHostsFile=\"") && a.ends_with("/known_hosts\"")));
    assert!(preview.argv.iter().any(|a| a == "ServerAliveInterval=30"));
    assert_eq!(&preview.argv[preview.argv.len()-2..], &["--", "saved.test"]);
    assert!(preview.display.ends_with("\"--\" \"saved.test\""));
    assert!(preview.config_notice.contains("~/.ssh/config does not apply"));

    let mut draft = input("draft.test");
    draft.jump_connection_id = Some(id.clone());
    let jump = temp.preview(PreviewSource::Draft { draft: Box::new(draft.clone()), editing_id: None }).unwrap();
    assert_eq!(jump.store_revision, saved.revision);
    assert_eq!(jump.argv.last().unwrap(), "draft.test");
    let proxy = if cfg!(windows) { "<native-ssh-proxy>" } else { "/bin/sh '<private-proxy-helper>'" };
    assert!(jump.argv.contains(&format!("ProxyCommand={proxy}")));
    assert!(jump.wrapper.contains("shown symbolically"));

    let self_jump = temp.preview(PreviewSource::Draft { draft: Box::new(draft), editing_id: Some(id) }).unwrap_err();
    assert_eq!(self_jump.code, "Validation");
    assert_eq!(self_jump.fields[0].field.as_deref(), Some("jumpConnectionId"));
    assert_eq!(self_jump.fields[0].code, "self");
    assert_eq!(fs::read(file).unwrap(), bytes);
    assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 2, "only ssh.json and its existing lock");
    assert_eq!(store.get().unwrap(), saved);
}

#[test]
fn preview_replies_preserve_field_codes_and_hide_store_errors() {
    let temp = Temp::new();
    let mut draft = input("new.test");
    draft.extra_options = vec![("NotAnAllowedOption".into(), "1".into())];
    let err = temp.preview(PreviewSource::Draft { draft: Box::new(draft), editing_id: None }).unwrap_err();
    let json = serde_json::to_value(err).unwrap();
    assert_eq!(json["code"], "Validation");
    assert_eq!(json["fields"][0]["field"], "extraOptions");
    assert_eq!(json["fields"][0]["code"], "option-not-allowed");

    let source = PreviewSource::Draft { draft: Box::new(input("new.test")), editing_id: None };
    assert_eq!(preview_in(&temp.store(), source, || Ok(("/usr/bin/ssh".into(), PathBuf::new())))
        .unwrap_err().code, "UnsupportedContext");
    assert_eq!(temp.preview(PreviewSource::Saved { id: "missing".into() }).unwrap_err().code, "NotFound");
    fs::create_dir_all(&temp.0).unwrap();
    fs::write(temp.0.join("ssh.json"), "invalid").unwrap();
    let err = temp.preview(PreviewSource::Saved { id: "missing".into() }).unwrap_err();
    assert_eq!(serde_json::to_value(err).unwrap(), serde_json::json!({
        "code": "StoreUnavailable", "message": "SSH definitions could not be read."
    }));
}
