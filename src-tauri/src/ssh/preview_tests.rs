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
    let text = &preview.commands.last().unwrap().text;
    assert!(text.ends_with(" -- saved.test"), "{text}");
    assert!(preview.commands.iter().all(|c| c.unavailable.is_none() && c.text.contains(" -- saved.test")));
    assert!(preview.config_notice.contains("~/.ssh/config does not apply"));

    let mut draft = input("draft.test");
    draft.jump_connection_id = Some(id.clone());
    let jump = temp.preview(PreviewSource::Draft { draft: Box::new(draft.clone()), editing_id: None }).unwrap();
    assert_eq!(jump.store_revision, saved.revision);
    assert_eq!(jump.argv.last().unwrap(), "draft.test");
    let proxy = if cfg!(windows) { "<native-ssh-proxy>" } else { "/bin/sh '<private-proxy-helper>'" };
    assert!(jump.argv.contains(&format!("ProxyCommand={proxy}")));
    assert!(jump.wrapper.contains("shown symbolically"));
    // Windows' native ProxyCommand needs no private payload, so its copy text is
    // the real command; a POSIX jump's helper exists only in a real launch.
    for command in &jump.commands {
        if cfg!(windows) {
            assert_eq!(command.unavailable, None);
            assert!(command.text.contains("ProxyCommand=") && !command.text.contains("<native-ssh-proxy>"), "{}", command.text);
        } else {
            assert_eq!(command.unavailable, Some(PRIVATE_HELPER));
        }
    }

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

fn args(words: &[&str]) -> Vec<String> {
    words.iter().map(|w| w.to_string()).collect()
}

#[test]
fn windows_copy_text_is_powershell_then_cmd_and_survives_both_powershell_editions() {
    let ssh = r"C:\WINDOWS\system32\OpenSSH\ssh.exe";
    // One ArgumentList string: 5.1 and 7.3+ both pass it to ssh.exe unchanged.
    // Embedded quotes, spaces, an empty argument, ' and the typographic quote
    // PowerShell also treats as a quote all go through it.
    let argv = args(&[ssh, "-o", "UserKnownHostsFile=\"C:/a b/known_hosts\"", "-l", "it's", "-o", "X=a&b|c%PATH%\u{2019}", "", "--", "h"]);
    let commands = shell_commands(&argv, Ok(&argv), true);
    assert_eq!(commands.iter().map(|c| c.shell).collect::<Vec<_>>(), ["powershell", "cmd"]);
    assert_eq!(commands[0].text, format!(
        r#"Start-Process -FilePath '{ssh}' -ArgumentList '-o "UserKnownHostsFile=\"C:/a b/known_hosts\"" -l it''s -o X=a&b|c%PATH%’’ "" -- h' -NoNewWindow -Wait"#));
    assert_eq!(commands[0].unavailable, None);
    // cmd cannot keep %PATH% literal in a pasted line.
    assert!(commands[1].unavailable.unwrap().contains("Command Prompt expands %"));

    let argv = args(&[ssh, "-o", "UserKnownHostsFile=\"C:/a b/known_hosts\"", "-o", "X=a&b", "", "--", "h"]);
    let commands = shell_commands(&argv, Ok(&argv), true);
    // cmd flips quote state at every ", so only the & outside quotes is escaped.
    assert_eq!(commands[1].text, format!(
        r#"{ssh} -o "UserKnownHostsFile=\"C:/a b/known_hosts\"" -o X=a^&b "" -- h"#));
    assert!(commands.iter().all(|c| c.unavailable.is_none()));
}

#[test]
fn copy_text_that_cannot_run_unchanged_says_why_instead() {
    let ssh = r"C:\ssh.exe";
    let pipe = args(&[ssh, "-o", "UserKnownHostsFile=\"C:/a|b/kh\"", "--", "h"]);
    let commands = shell_commands(&pipe, Ok(&pipe), true);
    assert!(commands.iter().all(|c| c.unavailable.is_none()));
    // cmd sees the quotes closed after \" so the | there is escaped.
    assert_eq!(commands[1].text, r#"C:\ssh.exe -o "UserKnownHostsFile=\"C:/a^|b/kh\"" -- h"#);

    // No runnable argv (a POSIX jump): show the symbolic text, but never as copyable.
    let symbolic = args(&["/usr/bin/ssh", "-o", "ProxyCommand=/bin/sh '<private-proxy-helper>'", "--", "h"]);
    let commands = shell_commands(&symbolic, Err(PRIVATE_HELPER), false);
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].unavailable, Some(PRIVATE_HELPER));
}

#[test]
fn posix_copy_text_single_quotes_only_what_needs_it() {
    let argv = args(&["/usr/bin/ssh", "-F", "none", "-o", "UserKnownHostsFile=\"/home/a b/kh\"", "-l", "it's", "", "--", "user@host.test"]);
    let commands = shell_commands(&argv, Ok(&argv), false);
    assert_eq!((commands[0].shell, commands[0].unavailable), ("sh", None));
    assert_eq!(commands[0].text,
        r#"/usr/bin/ssh -F none -o 'UserKnownHostsFile="/home/a b/kh"' -l 'it'\''s' '' -- user@host.test"#);
}

#[test]
fn missing_windows_openssh_client_has_its_own_code_and_instructions() {
    use crate::pty_manager::ssh_shell::{installed_ssh_client, NativeSshClient};
    let temp = Temp::new();
    let missing = temp.0.join("OpenSSH").join("ssh.exe").to_string_lossy().into_owned();
    let err = installed_ssh_client(Ok(missing)).unwrap_err();
    assert_eq!(err, NativeSshClient::Missing);
    let json = serde_json::to_value(PreviewError::native_ssh(err)).unwrap();
    assert_eq!(json["code"], "SshClientMissing");
    assert_eq!(json["message"], "Windows OpenSSH Client is not installed. Turn it on in Settings > System > Optional features > OpenSSH Client, then try again.");
    assert_eq!(installed_ssh_client(Err(std::io::Error::other("no system dir"))).unwrap_err(), NativeSshClient::Unavailable);
    assert_eq!(PreviewError::native_ssh(NativeSshClient::Unavailable).code, "UnsupportedContext");
    fs::create_dir_all(&temp.0).unwrap();
    let present = temp.0.join("ssh.exe");
    fs::write(&present, "").unwrap();
    let present = present.to_string_lossy().into_owned();
    assert_eq!(installed_ssh_client(Ok(present.clone())), Ok(present));
}

#[cfg(windows)]
#[test]
fn a_jump_command_too_long_for_windows_says_so_not_private_helper() {
    let temp = Temp::new();
    let store = temp.store();
    let saved = store.transact(|s| s.upsert_connection(input("bastion.test")), |_| {}).unwrap();
    let mut draft = input("draft.test");
    draft.jump_connection_id = Some(saved.view.connections[0].id.clone());
    // The known_hosts path appears in the ProxyCommand, so a long home overflows its 32,767 limit.
    let home = PathBuf::from(format!(r"C:\{}", "h".repeat(33_000)));
    let source = PreviewSource::Draft { draft: Box::new(draft), editing_id: None };
    let jump = preview_in(&store, source, || Ok((r"C:\ssh.exe".into(), home))).unwrap();
    assert!(jump.commands.iter().all(|c| c.unavailable == Some(TOO_LONG)), "{:?}", jump.commands.iter().map(|c| c.unavailable).collect::<Vec<_>>());
}
