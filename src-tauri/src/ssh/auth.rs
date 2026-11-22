//! Rust-only credential envelopes and the Phase B transactional persistence seam.
use super::session::{AuthMethod, SessionError, SessionHop};
use crate::automation_secret::MessageCipher;
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin, sync::Arc};
use zeroize::Zeroizing;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthBinding {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub identity_fingerprint: Option<String>,
}
impl AuthBinding {
    pub fn for_hop(hop: &SessionHop, identity_fingerprint: Option<String>) -> Self {
        Self {
            connection_id: hop.connection_id.clone(),
            host: hop.host.clone(),
            port: hop.port,
            user: hop.user.clone(),
            auth: hop.auth,
            identity_fingerprint,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretKind {
    Password,
    Passphrase,
}
// Intentionally not Debug. Only the ciphertext crosses SecretSink.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    version: u8,
    kind: SecretKind,
    password_or_passphrase: String,
    binding: AuthBinding,
}
impl Drop for Envelope {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.password_or_passphrase.zeroize();
    }
}
pub trait SecretSink: Send + Sync {
    fn load<'a>(
        &'a self,
        binding: &'a AuthBinding,
    ) -> BoxFuture<'a, Result<Option<String>, SessionError>>;
    /// Phase B MUST implement a reload/compare-binding/transact mutation, not an upsert.
    /// Recheck cancel in the transaction immediately before committing; preserve the
    /// old ciphertext/revision on cancellation, binding mismatch, or write failure.
    fn set_secret_if_binding_matches<'a>(
        &'a self,
        binding: &'a AuthBinding,
        ciphertext: String,
        cancel: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'a, Result<(), SessionError>>;
}
pub struct NoSecrets;
impl SecretSink for NoSecrets {
    fn load<'a>(
        &'a self,
        _: &'a AuthBinding,
    ) -> BoxFuture<'a, Result<Option<String>, SessionError>> {
        Box::pin(async { Ok(None) })
    }
    fn set_secret_if_binding_matches<'a>(
        &'a self,
        _: &'a AuthBinding,
        _: String,
        _: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async { Err(SessionError::RememberUnavailable) })
    }
}
pub struct CredentialCipher {
    cipher: Arc<MessageCipher>,
}
impl Default for CredentialCipher {
    fn default() -> Self {
        Self {
            cipher: MessageCipher::for_ssh(),
        }
    }
}
impl CredentialCipher {
    pub async fn seal(
        &self,
        kind: SecretKind,
        binding: AuthBinding,
        secret: Zeroizing<String>,
    ) -> Result<String, SessionError> {
        let cipher = self.cipher.clone();
        tokio::task::spawn_blocking(move || {
            let envelope = Envelope {
                version: 1,
                kind,
                binding,
                password_or_passphrase: secret.to_string(),
            };
            let plain = Zeroizing::new(
                serde_json::to_string(&envelope).map_err(|_| SessionError::RememberUnavailable)?,
            );
            cipher
                .encrypt(&plain)
                .map_err(|_| SessionError::RememberUnavailable)
        })
        .await
        .map_err(|_| SessionError::RememberUnavailable)?
    }
    pub async fn open(
        &self,
        kind: SecretKind,
        binding: AuthBinding,
        ciphertext: String,
    ) -> Result<Zeroizing<String>, SessionError> {
        let cipher = self.cipher.clone();
        tokio::task::spawn_blocking(move || {
            let plain = Zeroizing::new(
                cipher
                    .decrypt(&ciphertext)
                    .map_err(|_| SessionError::RememberUnavailable)?,
            );
            let envelope: Envelope =
                serde_json::from_str(&plain).map_err(|_| SessionError::RememberUnavailable)?;
            if envelope.version != 1 || envelope.kind != kind || envelope.binding != binding {
                return Err(SessionError::StaleAttempt);
            }
            Ok(Zeroizing::new(envelope.password_or_passphrase.clone()))
        })
        .await
        .map_err(|_| SessionError::RememberUnavailable)?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> AuthBinding {
        AuthBinding {
            connection_id: "c-a".into(),
            host: "host".into(),
            port: 22,
            user: "alice".into(),
            auth: AuthMethod::Password,
            identity_fingerprint: None,
        }
    }
    #[tokio::test]
    async fn changed_auth_binding_refuses_secret_read_and_save() {
        let cipher = CredentialCipher::default();
        let b = binding();
        let encrypted = cipher
            .seal(
                SecretKind::Password,
                b.clone(),
                Zeroizing::new("sentinel".into()),
            )
            .await
            .unwrap();
        assert!(!encrypted.contains("sentinel"));
        assert_eq!(
            &*cipher
                .open(SecretKind::Password, b.clone(), encrypted.clone())
                .await
                .unwrap(),
            "sentinel"
        );
        for mutated in [
            AuthBinding {
                host: "other".into(),
                ..b.clone()
            },
            AuthBinding {
                user: "other".into(),
                ..b.clone()
            },
            AuthBinding {
                identity_fingerprint: Some("new".into()),
                ..b.clone()
            },
            AuthBinding {
                connection_id: "jump".into(),
                ..b
            },
        ] {
            assert!(matches!(
                cipher
                    .open(SecretKind::Password, mutated, encrypted.clone())
                    .await,
                Err(SessionError::StaleAttempt)
            ));
        }
    }
    #[tokio::test]
    async fn ssh_and_automation_keys_are_separate() {
        let ssh = MessageCipher::for_ssh();
        let automation = MessageCipher::default();
        let encrypted = ssh.encrypt("ssh-secret").unwrap();
        assert!(automation.decrypt(&encrypted).is_err());
        let encrypted = automation.encrypt("automation-secret").unwrap();
        assert!(ssh.decrypt(&encrypted).is_err());
        let source: String = include_str!("../automation_secret.rs")
            .split_whitespace()
            .collect();
        assert!(source.contains("namespace:\"termflow-ssh\",account:\"secret-key\""));
        assert!(source.contains("namespace:\"termflow-automation\",account:\"message-key\""));
    }
}
