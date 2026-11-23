use std::path::Path;

use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine as _,
};
use sha2::{Digest, Sha256};
use ssh_key::{HashAlg, PrivateKey};
use zeroize::Zeroizing;

use super::session::SessionError;

#[derive(Clone)]
pub(crate) enum Identity {
    Key(Box<PrivateKey>),
    Locked {
        text: Zeroizing<String>,
        fingerprint: String,
    },
}

pub(crate) fn read_identity(path: &Path) -> Result<Identity, SessionError> {
    let bytes = Zeroizing::new(std::fs::read(path).map_err(|_| SessionError::IdentityUnreadable)?);
    let text = std::str::from_utf8(&bytes).map_err(|_| SessionError::IdentityUnreadable)?;
    parse_identity(Zeroizing::new(text.to_owned()))
}

pub(crate) fn parse_identity(mut text: Zeroizing<String>) -> Result<Identity, SessionError> {
    if text.starts_with('\u{feff}') {
        text = Zeroizing::new(text['\u{feff}'.len_utf8()..].to_owned());
    }
    let pem = from_begin(&text).ok_or(SessionError::IdentityUnreadable)?;
    let mut lines = pem.lines();
    let begin = lines.next().ok_or(SessionError::IdentityUnreadable)?;
    if begin == "-----BEGIN OPENSSH PRIVATE KEY-----" {
        return PrivateKey::from_openssh(pem.as_bytes())
            .map(|key| Identity::Key(Box::new(key)))
            .map_err(|_| SessionError::IdentityUnreadable);
    }
    let mut encrypted = false;
    let mut dek_info = None;
    let mut ended = false;
    let mut body = Zeroizing::new(String::new());
    for line in lines {
        if line.starts_with("-----END ") {
            ended = true;
            break;
        }
        if line.starts_with("-----BEGIN ") {
            return Err(SessionError::IdentityUnreadable);
        }
        encrypted |= line == "Proc-Type: 4,ENCRYPTED";
        if let Some(info) = line.strip_prefix("DEK-Info: ") {
            dek_info = Some(info);
        } else if !line.contains(':') {
            body.push_str(line.trim());
        }
    }
    match begin {
        "-----BEGIN ENCRYPTED PRIVATE KEY-----" => {}
        "-----BEGIN RSA PRIVATE KEY-----" if encrypted => {
            let (cipher, iv) = dek_info
                .and_then(|info| info.split_once(','))
                .ok_or(SessionError::IdentityUnreadable)?;
            if cipher != "AES-128-CBC" {
                return Err(SessionError::IdentityEncryptionUnsupported);
            }
            if iv.len() != 32 || !iv.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(SessionError::IdentityUnreadable);
            }
        }
        "-----BEGIN EC PRIVATE KEY-----" | "-----BEGIN PRIVATE KEY-----" if encrypted => {
            return Err(SessionError::IdentityEncryptionUnsupported);
        }
        "-----BEGIN RSA PRIVATE KEY-----"
        | "-----BEGIN EC PRIVATE KEY-----"
        | "-----BEGIN PRIVATE KEY-----"
            if !encrypted =>
        {
            return decode(pem, None)
                .map(|key| Identity::Key(Box::new(key)))
                .ok_or(SessionError::IdentityUnreadable);
        }
        _ => return Err(SessionError::IdentityUnreadable),
    }
    // A locked key is only checked again after the passphrase prompt, so reject a truncated or
    // corrupt armour now instead of prompting for a passphrase that can never succeed.
    if !ended
        || body.is_empty()
        || STANDARD
            .decode(body.as_bytes())
            .map(Zeroizing::new)
            .is_err()
    {
        return Err(SessionError::IdentityUnreadable);
    }
    // Encrypted PEM has no public key available before loading the saved passphrase.
    let normalized = Zeroizing::new(text.replace("\r\n", "\n"));
    let fingerprint = format!(
        "SHA256-FILE:{}",
        STANDARD_NO_PAD.encode(Sha256::digest(normalized.as_bytes()))
    );
    Ok(Identity::Locked { text, fingerprint })
}

fn from_begin(text: &str) -> Option<&str> {
    let mut rest = text;
    for line in text.split_inclusive('\n') {
        if line.starts_with("-----BEGIN ") {
            return Some(rest);
        }
        rest = &rest[line.len()..];
    }
    None
}

fn decode(text: &str, pass: Option<&str>) -> Option<PrivateKey> {
    russh::keys::decode_secret_key(text, pass)
        .ok()
        .filter(|key| !key.is_encrypted())
}

impl Identity {
    pub(crate) fn fingerprint(&self) -> String {
        match self {
            Self::Key(key) => key.public_key().fingerprint(HashAlg::Sha256).to_string(),
            Self::Locked { fingerprint, .. } => fingerprint.clone(),
        }
    }

    pub(crate) fn needs_passphrase(&self) -> bool {
        match self {
            Self::Key(key) => key.is_encrypted(),
            Self::Locked { .. } => true,
        }
    }

    pub(crate) fn unlock(&self, pass: &str) -> Result<PrivateKey, SessionError> {
        match self {
            Self::Key(key) if key.is_encrypted() => key
                .decrypt(pass.as_bytes())
                .map_err(|_| SessionError::AuthRejected),
            Self::Key(key) => Ok((**key).clone()),
            Self::Locked { text, .. } => from_begin(text)
                .and_then(|pem| decode(pem, Some(pass)))
                .ok_or(SessionError::AuthRejected),
        }
    }
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
