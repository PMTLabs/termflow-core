use super::support::*;
use crate::automation_secret::{KeySource, MessageCipher, SecretError};
use crate::automation_store::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct Unavailable(AtomicUsize);
impl KeySource for Unavailable {
    fn get(&self) -> Result<Option<[u8; 32]>, SecretError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(SecretError)
    }
    fn create(&self) -> Result<[u8; 32], SecretError> {
        panic!("must not create after failed fetch")
    }
}

fn raw(store: &AutomationStore, id: &str) -> String {
    store
        .conn
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .query_row(
            "SELECT graph FROM automation_rules WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn hidden_graph_round_trip_transactions_and_schema() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("hidden");
    r.graph.action_mut().masked = true;
    r.graph.action_mut().message = "fresh-password-123".into();
    store.save_rule(&r).unwrap();
    let encrypted = raw(&store, &r.id);
    assert!(!encrypted.contains("fresh-password"));
    assert!(encrypted.contains("v1:"));
    let loaded = store.get_rule(&r.id).unwrap().unwrap();
    assert_eq!(
        loaded.graph.action.as_ref().unwrap().message,
        "fresh-password-123"
    );
    assert_eq!(loaded.schema_version, 4);
    assert_eq!(
        store.list_rules().unwrap()[0]
            .graph
            .action
            .as_ref()
            .unwrap()
            .message,
        "fresh-password-123"
    );
    store.set_enabled_checked(&r.id, true).unwrap();
    let copy = store.duplicate_automation(&r.id, 2000).unwrap();
    assert_eq!(
        store
            .get_rule(&copy.id)
            .unwrap()
            .unwrap()
            .graph
            .action
            .as_ref()
            .unwrap()
            .message,
        "fresh-password-123"
    );
    store.add_target_to_rule(&r.id, "tm-2", 3000).unwrap();
    store
        .remove_target_from_rule(&r.id, &["tm-2".into()], 4000)
        .unwrap();
    store.set_verbose_until(&r.id, Some(5000)).unwrap();
    store.sweep_expired_verbose(6000).unwrap();
    store.mark_completed(&r.id, 7000).unwrap();
    store.clear_completed(&r.id).unwrap();
    store.set_enabled_checked(&r.id, false).unwrap();
    assert_eq!(raw(&store, &r.id), encrypted);
    let mut unhidden = loaded;
    unhidden.graph.action_mut().masked = false;
    store.save_rule(&unhidden).unwrap();
    assert!(store.get_rule(&r.id).unwrap().unwrap().schema_version < 4);
}

#[test]
fn unreadable_preserves_cipher_and_refuses_enable_and_duplicate_keeps_it() {
    let store = AutomationStore::new_in_memory();
    let mut r = rule("unreadable");
    r.enabled = false;
    r.graph.action_mut().masked = true;
    r.graph.action_mut().message.clear();
    r.graph.action_mut().message_cipher = Some("v1:unreadable".into());
    store.save_rule(&r).unwrap();
    let original = raw(&store, &r.id);
    let mut loaded = store.get_rule(&r.id).unwrap().unwrap();
    assert_eq!(
        loaded
            .graph
            .action
            .as_ref()
            .unwrap()
            .message_cipher
            .as_deref(),
        Some("v1:unreadable")
    );
    assert!(crate::automation_validation::problems(&loaded)
        .iter()
        .any(|p| p.code == "action.hiddenUnreadable" && p.blocks()));
    store.save_rule(&loaded).unwrap();
    loaded.name = "unrelated edit".into();
    store.save_rule(&loaded).unwrap();
    assert_eq!(raw(&store, &r.id), original);
    assert!(store
        .set_enabled_checked(&r.id, true)
        .unwrap_err()
        .to_string()
        .contains("type it again"));
    let copy = store.duplicate_automation(&r.id, 2000).unwrap();
    assert_eq!(
        copy.graph.action.as_ref().unwrap().message_cipher,
        r.graph.action.as_ref().unwrap().message_cipher
    );
    store.add_target_to_rule(&r.id, "tm-2", 3000).unwrap();
    store
        .remove_target_from_rule(&r.id, &["tm-2".into()], 4000)
        .unwrap();
    assert_eq!(raw(&store, &r.id), original);
}

#[test]
fn unmasked_never_fetches_and_unavailable_hidden_saves_retry() {
    let source = Arc::new(Unavailable(AtomicUsize::new(0)));
    let mut store = AutomationStore::new_in_memory();
    store.cipher = MessageCipher::new(source.clone());
    let mut r = rule("unavailable");
    store.save_rule(&r).unwrap();
    store.get_rule(&r.id).unwrap();
    store.list_rules().unwrap();
    assert_eq!(source.0.load(Ordering::SeqCst), 0);
    r.graph.action_mut().masked = true;
    for _ in 0..2 {
        assert!(store.save_rule(&r).unwrap_err().to_string().contains("Can't hide this message: no system keystore is available. Turn off Hide message to save it."));
    }
    assert_eq!(source.0.load(Ordering::SeqCst), 2);
    assert!(!raw(&store, &r.id).contains("v1:"));
}

#[test]
fn legacy_defaults_and_debug_redaction() {
    let mut a: ActionStep = serde_json::from_str(r#"{"message":"secret-${password}"}"#).unwrap();
    assert!(!a.masked);
    assert!(a.message_cipher.is_none());
    a.masked = true;
    a.message_cipher = Some("cipher-secret".into());
    let debug = format!("{a:?}");
    assert!(!debug.contains("secret"));
    assert!(!debug.contains("password"));
}

#[test]
fn checkpointed_file_contains_no_fresh_hidden_plaintext() {
    let path = std::env::temp_dir().join(format!("termflow-hidden-{}.db", uuid::Uuid::new_v4()));
    let store = AutomationStore::new();
    store.init(&path);
    let secret = "fresh-hidden-only-never-plaintext-798164025";
    let mut r = rule("file-hidden");
    r.graph.action_mut().message = secret.into();
    r.graph.action_mut().masked = true;
    store.save_rule(&r).unwrap();
    store
        .conn
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    assert!(!std::fs::read(&path)
        .unwrap()
        .windows(secret.len())
        .any(|s| s == secret.as_bytes()));
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn renderer_wire_actions_serialize_and_hydrate_to_shared_refetch_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../src/renderer/components/Automation/__fixtures__/hiddenMessageWireCases.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let store = AutomationStore::new_in_memory();
        let mut r = rule("wire");
        r.enabled = false;
        r.graph.action = Some(serde_json::from_value(case["input"].clone()).unwrap());
        store.save_rule_as_of(&r, 2000).unwrap();
        let loaded = store.get_rule(&r.id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(loaded.graph.action.unwrap()).unwrap(),
            case["hydrated"]
        );
    }
}

#[test]
fn full_rule_readers_hydrate_and_graph_upserts_encrypt() {
    let sql = include_str!("../../sql.rs");
    let methods = include_str!("../methods.rs");
    assert_eq!(sql.matches("read_rule_row,").count(), 1);
    assert_eq!(sql.matches("read_rule_row)").count(), 1);
    assert_eq!(sql.matches("hydrate_rule(raw, &self.cipher)").count(), 2);
    assert_eq!(
        methods.matches("graph           = excluded.graph").count(),
        1
    );
    assert!(methods.contains("self.cipher.encrypt(&action.message)"));
    assert!(!sql.contains("SET graph"));
    assert!(!sql.contains("INSERT INTO automation_rules ("));
    assert_eq!(sql.matches("SELECT {RULE_COLUMNS}").count(), 2);
    assert_eq!(methods.matches("INSERT INTO automation_rules (").count(), 1);
}
