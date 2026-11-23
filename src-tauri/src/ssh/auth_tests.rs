use super::{auth::BoxFuture, session::*, tests::*};
use russh::keys::{agent::client::AgentClient, signature::Signer, ssh_encoding::Encode};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

fn string(out: &mut Vec<u8>, value: &[u8]) {
    out.extend((value.len() as u32).to_be_bytes());
    out.extend(value);
}
fn take_string<'a>(input: &mut &'a [u8]) -> &'a [u8] {
    let n = u32::from_be_bytes(input[..4].try_into().unwrap()) as usize;
    let value = &input[4..4 + n];
    *input = &input[4 + n..];
    value
}
async fn fake_agent<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    keys: Vec<ssh_key::PrivateKey>,
    signs: Arc<AtomicUsize>,
    locked: bool,
) {
    while let Ok(length) = stream.read_u32().await {
        assert!(length < 256 * 1024);
        let mut bytes = vec![0; length as usize];
        if stream.read_exact(&mut bytes).await.is_err() {
            break;
        }
        let mut reply = Vec::new();
        match bytes[0] {
            11 if !locked => {
                reply.push(12);
                reply.extend((keys.len() as u32).to_be_bytes());
                for key in &keys {
                    string(&mut reply, &key.public_key().to_bytes().unwrap());
                    string(&mut reply, b"fixture");
                }
            }
            13 if !locked => {
                let mut fields = &bytes[1..];
                let public = take_string(&mut fields);
                let message = take_string(&mut fields);
                if let Some(key) = keys
                    .iter()
                    .find(|k| k.public_key().to_bytes().unwrap() == public)
                {
                    signs.fetch_add(1, Ordering::SeqCst);
                    let sig: ssh_key::Signature = key.try_sign(message).unwrap();
                    let mut encoded = Vec::new();
                    sig.encode(&mut encoded).unwrap();
                    reply.push(14);
                    string(&mut reply, &encoded);
                } else {
                    reply.push(5);
                }
            }
            _ => reply.push(5),
        }
        if stream.write_u32(reply.len() as u32).await.is_err()
            || stream.write_all(&reply).await.is_err()
        {
            break;
        }
    }
}
struct FakeAgent {
    keys: Vec<ssh_key::PrivateKey>,
    signs: Arc<AtomicUsize>,
    locked: bool,
}
impl AgentFactory for FakeAgent {
    fn connect(&self) -> BoxFuture<'_, Result<DynamicAgent, SessionError>> {
        Box::pin(async {
            let (client, server) = tokio::io::duplex(8192);
            let keys = self.keys.clone();
            let signs = self.signs.clone();
            let locked = self.locked;
            tokio::spawn(fake_agent(server, keys, signs, locked));
            Ok(AgentClient::connect(client).dynamic())
        })
    }
}
fn with_agent(f: &Fixture, agent: Arc<dyn AgentFactory>) {
    let hop = SessionHop {
        auth: AuthMethod::Agent,
        ..hop("c-a", "alice")
    };
    f.registry
        .configure(Dependencies {
            targets: Arc::new(Targets(SessionTarget { hops: vec![hop] })),
            streams: Arc::new(MemoryStreams(f.server.clone())),
            agents: agent,
            secrets: f.secrets.clone(),
            events: f.events.clone(),
            known_hosts: super::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: f.path.parent().unwrap().into(),
        })
        .unwrap();
}
#[tokio::test]
async fn healthy_agent_server_rejection_is_auth_rejected() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    with_agent(
        &f,
        Arc::new(FakeAgent {
            keys: vec![key(12)],
            signs: Arc::new(AtomicUsize::new(0)),
            locked: false,
        }),
    );
    let id = f.registry.probe("c-a").unwrap();
    let v = wait_state(&f.registry, &id, true, SessionState::Error).await;
    assert_eq!(v.reason, Some(SessionError::AuthRejected.reason()));
    assert_eq!(v.error_code.as_deref(), Some("auth-rejected"));
    f.registry.shutdown().await;
}
#[tokio::test]
async fn agent_first_identity_refused_second_accepted() {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let signs = Arc::new(AtomicUsize::new(0));
    with_agent(
        &f,
        Arc::new(FakeAgent {
            keys: vec![key(12), key(11)],
            signs: signs.clone(),
            locked: false,
        }),
    );
    let id = f.registry.probe("c-a").unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert_eq!(signs.load(Ordering::SeqCst), 2);
    assert_eq!(*f.server.counters.principals.lock(), vec!["alice", "alice"]);
    f.registry.shutdown().await;
}
#[tokio::test]
async fn agent_missing_locked_empty_and_timeout_are_errors() {
    for locked in [false, true] {
        let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
        with_agent(
            &f,
            Arc::new(FakeAgent {
                keys: vec![],
                signs: Arc::new(AtomicUsize::new(0)),
                locked,
            }),
        );
        let id = f.registry.probe("c-a").unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let view = f.registry.state(&id, true).unwrap();
                if matches!(view.state, SessionState::Error | SessionState::Disconnected) {
                    assert_ne!(view.state, SessionState::Connected);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        f.registry.shutdown().await;
    }
}
#[tokio::test(start_paused = true)]
async fn agent_missing_and_connect_timeout_never_authenticate() {
    struct Agent {
        started: tokio::sync::Notify,
        missing: bool,
    }
    impl AgentFactory for Agent {
        fn connect(&self) -> BoxFuture<'_, Result<DynamicAgent, SessionError>> {
            Box::pin(async {
                self.started.notify_one();
                if self.missing {
                    Err(SessionError::AgentUnavailable)
                } else {
                    std::future::pending().await
                }
            })
        }
    }
    for missing in [true, false] {
        let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
        let agent = Arc::new(Agent {
            started: tokio::sync::Notify::new(),
            missing,
        });
        with_agent(&f, agent.clone());
        let id = f.registry.probe("c-a").unwrap();
        agent.started.notified().await;
        if !missing {
            tokio::time::advance(Duration::from_secs(31)).await;
        }
        for _ in 0..100 {
            if matches!(
                f.registry.state(&id, true).unwrap().state,
                SessionState::Error | SessionState::Disconnected
            ) {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(matches!(
            f.registry.state(&id, true).unwrap().state,
            SessionState::Error | SessionState::Disconnected
        ));
        assert_eq!(f.server.counters.auth.load(Ordering::SeqCst), 0);
        f.registry.shutdown().await;
    }
}
#[tokio::test]
async fn encrypted_key_wrong_then_correct_passphrase() {
    encrypted_key_flow(include_str!("fixtures/client_enc"), "spikepass").await;
}
#[tokio::test]
async fn encrypted_pkcs8_wrong_then_correct_passphrase() {
    encrypted_key_flow(include_str!("fixtures/key_formats/rsa_pkcs8_enc"), "fixture-pass").await;
}
fn key_fixture(fixture: &str, public: ssh_key::PublicKey) -> Fixture {
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let mut server = f.server.clone();
    server.client = public;
    let identity = f.path.with_file_name("identity");
    std::fs::write(&identity, fixture).unwrap();
    let hop = SessionHop {
        auth: AuthMethod::Key,
        identity_file: Some(identity.to_string_lossy().into_owned()),
        ..hop("c-a", "alice")
    };
    f.registry
        .configure(Dependencies {
            targets: Arc::new(Targets(SessionTarget { hops: vec![hop] })),
            streams: Arc::new(MemoryStreams(server)),
            agents: Arc::new(NativeAgent),
            secrets: f.secrets.clone(),
            events: f.events.clone(),
            known_hosts: super::known_hosts::KnownHosts {
                path: f.path.clone(),
            },
            home: f.path.parent().unwrap().into(),
        })
        .unwrap();
    f
}
pub(super) async fn encrypted_key_flow(
    fixture: &str,
    pass: &str,
) -> (super::auth::AuthBinding, String) {
    let decoded = russh::keys::decode_secret_key(fixture, Some(pass)).unwrap();
    let f = key_fixture(fixture, decoded.public_key().clone());
    let id = f.registry.probe("c-a").unwrap();
    let a = wait_state(&f.registry, &id, true, SessionState::NeedsSecret).await;
    assert_eq!(a.secret_kind, Some(super::auth::SecretKind::Passphrase));
    f.registry
        .submit_secret(
            &id,
            true,
            None,
            a.prompt_id.as_deref(),
            "wrong".into(),
            true,
        )
        .unwrap();
    let b = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let v = f.registry.state(&id, true).unwrap();
            if v.state == SessionState::NeedsSecret && v.prompt_id != a.prompt_id {
                break v;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(b.error_code.as_deref(), Some("auth-rejected"));
    assert_eq!(f.secrets.saves.load(Ordering::SeqCst), 0);
    f.registry
        .submit_secret(
            &id,
            true,
            None,
            b.prompt_id.as_deref(),
            pass.into(),
            true,
        )
        .unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert_eq!(f.secrets.saves.load(Ordering::SeqCst), 1);
    let path = f.path.with_file_name("identity");
    let fingerprint = super::identity::read_identity(&path).unwrap().fingerprint();
    let saved = f.secrets.values.lock()["c-a"].clone();
    assert_eq!(saved.0.identity_fingerprint.as_deref(), Some(fingerprint.as_str()));
    f.registry.shutdown().await;
    saved
}
#[tokio::test]
async fn plain_rsa_pem_connects_without_prompt() {
    let public = ssh_key::PublicKey::from_openssh(include_str!("fixtures/key_formats/rsa_pem.pub")).unwrap();
    let f = key_fixture(include_str!("fixtures/key_formats/rsa_pem"), public);
    let id = f.registry.probe("c-a").unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert!(!f.events.0.lock().iter().any(|view| view.state == SessionState::NeedsSecret));
    f.registry.shutdown().await;
}
#[tokio::test]
async fn des3_rsa_pem_encryption_is_unsupported_without_prompt() {
    let public = ssh_key::PublicKey::from_openssh(include_str!("fixtures/client_rsa.pub")).unwrap();
    let f = key_fixture(include_str!("fixtures/key_formats/rsa_pem_des3"), public);
    let id = f.registry.probe("c-a").unwrap();
    let view = wait_state(&f.registry, &id, true, SessionState::Error).await;
    assert_eq!(view.error_code.as_deref(), Some("identity-encryption-unsupported"));
    assert!(!f.events.0.lock().iter().any(|view| view.state == SessionState::NeedsSecret));
    f.registry.shutdown().await;
}
#[cfg(unix)]
#[tokio::test]
async fn agent_transport_unix_sock() {
    struct Endpoint(std::path::PathBuf);
    impl AgentFactory for Endpoint {
        fn connect(&self) -> BoxFuture<'_, Result<DynamicAgent, SessionError>> {
            Box::pin(async {
                AgentClient::connect_uds(&self.0)
                    .await
                    .map(|a| a.dynamic())
                    .map_err(|_| SessionError::AgentUnavailable)
            })
        }
    }
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let path = std::env::temp_dir().join(format!("tf-agent-{}", uuid::Uuid::new_v4()));
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let signs = Arc::new(AtomicUsize::new(0));
    let signed = signs.clone();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        fake_agent(stream, vec![key(11)], signed, false).await;
    });
    with_agent(&f, Arc::new(Endpoint(path.clone())));
    let id = f.registry.probe("c-a").unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert_eq!(signs.load(Ordering::SeqCst), 1);
    f.registry.shutdown().await;
    task.await.unwrap();
    std::fs::remove_file(path).unwrap();
}
#[cfg(windows)]
#[tokio::test]
async fn agent_transport_windows_pipe() {
    struct Endpoint(String);
    impl AgentFactory for Endpoint {
        fn connect(&self) -> BoxFuture<'_, Result<DynamicAgent, SessionError>> {
            Box::pin(async {
                AgentClient::connect_named_pipe(&self.0)
                    .await
                    .map(|a| a.dynamic())
                    .map_err(|_| SessionError::AgentUnavailable)
            })
        }
    }
    let f = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
    let path = format!(r"\\.\pipe\tf-agent-{}", uuid::Uuid::new_v4());
    let server = tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(true)
        .create(&path)
        .unwrap();
    let signs = Arc::new(AtomicUsize::new(0));
    let signed = signs.clone();
    let task = tokio::spawn(async move {
        server.connect().await.unwrap();
        fake_agent(server, vec![key(11)], signed, false).await;
    });
    with_agent(&f, Arc::new(Endpoint(path)));
    let id = f.registry.probe("c-a").unwrap();
    wait_state(&f.registry, &id, true, SessionState::Connected).await;
    assert_eq!(signs.load(Ordering::SeqCst), 1);
    f.registry.shutdown().await;
    task.await.unwrap();
}
