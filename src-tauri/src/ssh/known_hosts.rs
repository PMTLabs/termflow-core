//! Conservative native OpenSSH trust policy. No ambient paths in tests.
use super::session::SessionError;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use sha1::Sha1;
use ssh_key::{
    known_hosts::{Entry, HostPatterns, Marker},
    PublicKey,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Verified,
    Unknown,
}
pub(crate) fn canonical_host(host: &str) -> Result<String, SessionError> {
    let raw = if let Some(inner) = host.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return inner
            .parse::<std::net::Ipv6Addr>()
            .map(|ip| ip.to_string())
            .map_err(|_| SessionError::InvalidTarget);
    } else {
        host
    };
    if raw.contains([',', '*', '?', '!', '|', '@', '#', '[', ']', '/', '\\']) {
        return Err(SessionError::InvalidTarget);
    }
    if let Ok(ip) = raw.parse::<std::net::IpAddr>() {
        return Ok(ip.to_string());
    }
    let raw = raw.strip_suffix('.').unwrap_or(raw);
    if raw.len() > 253
        || raw.is_empty()
        || !raw.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
    {
        return Err(SessionError::InvalidTarget);
    }
    Ok(raw.to_ascii_lowercase())
}
#[test]
fn canonical_internal_labels_and_one_root_dot() {
    assert_eq!(
        canonical_host("Web_01.Internal.").unwrap(),
        "web_01.internal"
    );
    assert_eq!(lookup_token("Web_01.Internal.", 22), "web_01.internal");
    for host in ["host..", "host.example..", "a..b", ".."] {
        assert_eq!(canonical_host(host), Err(SessionError::InvalidTarget));
    }
}
pub fn lookup_token(host: &str, port: u16) -> String {
    let canonical = canonical_host(host).unwrap_or_else(|_| host.into());
    let host = canonical.as_str();
    if port == 22 {
        host.to_ascii_lowercase()
    } else {
        format!("[{}]:{port}", host.to_ascii_lowercase())
    }
}
fn glob(pattern: &str, token: &str) -> bool {
    let (p, t) = (pattern.as_bytes(), token.as_bytes());
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < t.len() {
        if i < p.len() && (p[i] == b'?' || p[i].eq_ignore_ascii_case(&t[j])) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(s) = star {
            retry += 1;
            j = retry;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}
fn valid_host_pattern(pattern: &str) -> bool {
    let pattern = pattern.strip_prefix('!').unwrap_or(pattern);
    if pattern.is_empty() || pattern.contains(['!', '|', '/', '\\', '@']) {
        return false;
    }
    if pattern.contains(['[', ']']) {
        let Some(rest) = pattern.strip_prefix('[') else {
            return false;
        };
        let Some((host, port)) = rest.split_once("]:") else {
            return false;
        };
        return !host.is_empty()
            && !host.contains(['[', ']'])
            && !port.is_empty()
            && port
                .chars()
                .all(|c| c.is_ascii_digit() || c == '*' || c == '?');
    }
    true
}
fn matches(patterns: &HostPatterns, token: &str) -> bool {
    match patterns {
        HostPatterns::HashedName { salt, hash } => {
            let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(salt) else {
                return false;
            };
            mac.update(token.as_bytes());
            mac.verify_slice(hash).is_ok()
        }
        HostPatterns::Patterns(patterns) => {
            let mut positive = false;
            for p in patterns {
                if let Some(p) = p.strip_prefix('!') {
                    if glob(p, token) {
                        return false;
                    }
                } else {
                    positive |= glob(p, token);
                }
            }
            positive
        }
    }
}
fn parse_host_field(host: &str) -> Option<HostPatterns> {
    if host.starts_with('|') {
        let (salt, hash) = host.strip_prefix("|1|")?.split_once('|')?;
        let salt = STANDARD.decode(salt).ok()?;
        let hash = STANDARD.decode(hash).ok()?.try_into().ok()?;
        return (salt.len() == 20).then_some(HostPatterns::HashedName { salt, hash });
    }
    host.split(',').all(valid_host_pattern)
        .then(|| HostPatterns::Patterns(host.split(',').map(str::to_owned).collect()))
}
pub fn classify(bytes: &[u8], token: &str, key: &PublicKey) -> Result<Verdict, SessionError> {
    if bytes.contains(&0) {
        return Err(SessionError::KnownHostsMalformed { line: 0 });
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let text =
        std::str::from_utf8(bytes).map_err(|_| SessionError::KnownHostsMalformed { line: 0 })?;
    let (mut pinned, mut exact, mut ca, mut revoked) = (false, false, false, false);
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let n = index + 1;
        let fields: Vec<_> = line.split_whitespace().collect();
        let host_index = usize::from(fields[0].starts_with('@'));
        let host = fields.get(host_index).copied();
        let Some(patterns) = host.and_then(parse_host_field) else {
            // OpenSSH still matches the valid patterns of a plain list, so a line that could name
            // this host must fail closed: skipping it would drop a revocation or a pin.
            if let Some(host) = host.filter(|h| !h.starts_with('|')) {
                let valid = host.split(',').filter(|p| valid_host_pattern(p)).map(str::to_owned);
                if matches(&HostPatterns::Patterns(valid.collect()), token) {
                    return Err(SessionError::KnownHostsMalformed { line: n });
                }
            }
            log::warn!("known_hosts line {n} skipped: host field could not be parsed");
            continue;
        };
        let matched = matches(&patterns, token);
        let parsed = fields.join(" ").parse::<Entry>();
        if !matched {
            // Parsing unrelated entries is diagnostic only.
            if parsed.is_err() {
                log::warn!("known_hosts line {n} skipped: entry could not be parsed");
            }
            continue;
        }
        let entry = parsed.map_err(|_| SessionError::KnownHostsMalformed { line: n })?;
        match entry.marker() {
            Some(Marker::Revoked) => {
                // Revocation denies this key; it does not pin an unrelated key.
                revoked |= entry.public_key().key_data() == key.key_data();
            }
            Some(Marker::CertAuthority) => ca = true,
            None => {
                pinned = true;
                exact |= entry.public_key().key_data() == key.key_data();
            }
        }
    }
    if revoked {
        Err(SessionError::HostKeyRevoked)
    } else if exact {
        Ok(Verdict::Verified)
    } else if pinned {
        Err(SessionError::HostKeyChanged)
    } else if ca {
        Err(SessionError::HostCertificateUnsupported)
    } else {
        Ok(Verdict::Unknown)
    }
}
#[derive(Clone)]
pub struct KnownHosts {
    pub path: PathBuf,
}
#[derive(PartialEq, Eq)]
struct Identity(u64, u64);
#[cfg(unix)]
fn identity(file: &File) -> Result<Identity, SessionError> {
    use std::os::unix::fs::MetadataExt;
    let meta = file
        .metadata()
        .map_err(|_| SessionError::TrustWriteFailed)?;
    Ok(Identity(meta.dev(), meta.ino()))
}
#[cfg(windows)]
fn identity(file: &File) -> Result<Identity, SessionError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(SessionError::TrustWriteFailed);
    }
    Ok(Identity(
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}
fn snapshot(path: &Path) -> Result<(Vec<u8>, Option<Identity>), SessionError> {
    match File::open(path) {
        Ok(mut file) => {
            let id = identity(&file)?;
            let mut bytes = Vec::new();
            // Bound trust-file parsing too. A huge file is not an empty store.
            Read::by_ref(&mut file)
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| SessionError::KnownHostsUnreadable)?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err(SessionError::KnownHostsUnreadable);
            }
            Ok((bytes, Some(id)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((vec![], None)),
        Err(_) => Err(SessionError::KnownHostsUnreadable),
    }
}
impl KnownHosts {
    pub async fn verify(&self, token: String, key: PublicKey) -> Result<Verdict, SessionError> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || classify(&snapshot(&path)?.0, &token, &key))
            .await
            .map_err(|_| SessionError::KnownHostsUnreadable)?
    }
    pub async fn trust(
        &self,
        token: String,
        key: PublicKey,
        cancel: CancellationToken,
    ) -> Result<(), SessionError> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || trust_transaction(&path, &token, &key, &cancel, || {}))
            .await
            .map_err(|_| SessionError::TrustWriteFailed)?
    }
}
fn private_parent(path: &Path) -> Result<(), SessionError> {
    let parent = path.parent().ok_or(SessionError::TrustWriteFailed)?;
    if !parent.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder
                .create(parent)
                .map_err(|_| SessionError::TrustWriteFailed)?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(parent).map_err(|_| SessionError::TrustWriteFailed)?;
    }
    Ok(())
}
fn trust_transaction(
    path: &Path,
    token: &str,
    key: &PublicKey,
    cancel: &CancellationToken,
    after_read: impl FnOnce(),
) -> Result<(), SessionError> {
    use fs4::FileExt;
    let (host, port) = if let Some(rest) = token.strip_prefix('[') {
        let (host, port) = rest.rsplit_once("]:").ok_or(SessionError::InvalidTarget)?;
        (
            host,
            port.parse::<u16>()
                .map_err(|_| SessionError::InvalidTarget)?,
        )
    } else {
        (token, 22)
    };
    if port == 0 || lookup_token(&canonical_host(host)?, port) != token {
        return Err(SessionError::InvalidTarget);
    }
    private_parent(path)?;
    let lock_path = path.with_file_name(format!(
        "{}.termflow.lock",
        path.file_name()
            .ok_or(SessionError::TrustWriteFailed)?
            .to_string_lossy()
    ));
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(lock_path)
        .map_err(|_| SessionError::TrustWriteFailed)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if cancel.is_cancelled() {
            return Err(SessionError::Cancelled);
        }
        match FileExt::try_lock(&lock) {
            Ok(()) => break,
            Err(fs4::TryLockError::WouldBlock) => {}
            Err(_) => return Err(SessionError::TrustWriteFailed),
        }
        if Instant::now() >= deadline {
            return Err(SessionError::TimedOut);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // File close releases the stable sidecar lock on every return path.
    let (bytes, expected) = snapshot(path)?;
    match classify(&bytes, token, key)? {
        Verdict::Verified => return Err(SessionError::TrustAlreadyPinned),
        Verdict::Unknown => {}
    }
    after_read();
    if cancel.is_cancelled() {
        return Err(SessionError::Cancelled);
    }
    let mut options = OpenOptions::new();
    options.append(true);
    if expected.is_none() {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| SessionError::TrustWriteFailed)?;
    if let Some(expected) = expected {
        if identity(&file)? != expected {
            return Err(SessionError::TrustWriteFailed);
        }
    }
    // Recheck bytes as well as identity (in-place revocation by a non-cooperating writer).
    let (current, current_id) = snapshot(path)?;
    if current != bytes || current_id != Some(identity(&file)?) {
        return Err(SessionError::TrustWriteFailed);
    }
    if cancel.is_cancelled() {
        return Err(SessionError::Cancelled);
    }
    let public = key
        .to_openssh()
        .map_err(|_| SessionError::TrustWriteFailed)?;
    let newline = if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        "\n"
    } else {
        ""
    };
    file.write_all(format!("{newline}{token} {public}\n").as_bytes())
        .map_err(|_| SessionError::TrustWriteFailed)?;
    #[cfg(test)]
    sync_probe::notify(path, false);
    file.sync_all()
        .map_err(|_| SessionError::TrustWriteFailed)?;
    #[cfg(test)]
    sync_probe::notify(path, true);
    drop(file);
    // Final verification detects external replacement; advisory locking cannot exclude it.
    if classify(&snapshot(path)?.0, token, key)? != Verdict::Verified {
        return Err(SessionError::TrustWriteFailed);
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod sync_probe {
    use super::*;
    use std::sync::{Arc, OnceLock};

    type Observer = Arc<dyn Fn(bool) + Send + Sync>;
    type Probes = parking_lot::Mutex<std::collections::HashMap<PathBuf, Observer>>;

    fn probes() -> &'static Probes {
        static PROBES: OnceLock<Probes> = OnceLock::new();
        PROBES.get_or_init(Default::default)
    }

    pub(crate) struct Guard(PathBuf);
    impl Drop for Guard {
        fn drop(&mut self) { probes().lock().remove(&self.0); }
    }

    pub(crate) fn at(path: &Path, callback: impl Fn(bool) + Send + Sync + 'static) -> Guard {
        assert!(probes().lock().insert(path.into(), Arc::new(callback)).is_none());
        Guard(path.into())
    }

    pub(super) fn notify(path: &Path, synced: bool) {
        let callback = probes().lock().get(path).cloned();
        if let Some(callback) = callback { callback(synced); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(seed: u8) -> PublicKey {
        ssh_key::PrivateKey::from(ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]))
            .public_key()
            .clone()
    }
    pub fn temporary() -> PathBuf {
        std::env::temp_dir()
            .join(format!("tf-ssh-{}", uuid::Uuid::new_v4()))
            .join(".ssh/known_hosts")
    }
    #[test]
    fn trust_rejects_pattern_injection_before_any_write() {
        let path = temporary();
        for token in [
            "a,*.prod",
            "*",
            "?",
            "!a",
            "|1|a|b",
            "@a",
            "#a",
            "[a]",
            "a/b",
            "a\\b",
            "[a]:2222,[*.prod]:2222",
        ] {
            assert_eq!(
                trust_transaction(&path, token, &key(1), &CancellationToken::new(), || {}),
                Err(SessionError::InvalidTarget),
                "{token}"
            );
            assert!(!path.exists());
            assert!(!path.parent().unwrap().exists());
        }
    }
    #[test]
    fn host_key_policy_table() {
        let (key, other) = (key(1), key(2));
        let k = key.to_openssh().unwrap();
        let o = other.to_openssh().unwrap();
        let rows = [
            (format!("host {o}"), Err(SessionError::HostKeyChanged)),
            (format!("@revoked * {o}"), Ok(Verdict::Unknown)),
            (format!("@revoked * {k}"), Err(SessionError::HostKeyRevoked)),
            (format!("host {o}\nhost {k}"), Ok(Verdict::Verified)),
            (
                format!("host {k}\n@revoked host {k}"),
                Err(SessionError::HostKeyRevoked),
            ),
            (
                format!("@cert-authority host {k}"),
                Err(SessionError::HostCertificateUnsupported),
            ),
            (
                format!("@unknown host {k}"),
                Err(SessionError::KnownHostsMalformed { line: 1 }),
            ),
            (
                "host ssh-ed25519 !!!".into(),
                Err(SessionError::KnownHostsMalformed { line: 1 }),
            ),
            (format!("@unknown other {k}"), Ok(Verdict::Unknown)),
            // D81: an unknown hash scheme can't name any host, so it is skipped.
            (format!("|2|bad|bad {k}"), Ok(Verdict::Unknown)),
            // D81: a plain list with an invalid pattern fails closed when a valid pattern matches.
            (
                format!("host,,else {k}"),
                Err(SessionError::KnownHostsMalformed { line: 1 }),
            ),
            (String::new(), Ok(Verdict::Unknown)),
        ];
        for (bytes, expected) in rows {
            assert_eq!(classify(bytes.as_bytes(), "host", &key), expected);
            if expected.is_err() {
                let path = temporary();
                private_parent(&path).unwrap();
                fs::write(&path, &bytes).unwrap();
                assert!(
                    trust_transaction(&path, "host", &key, &CancellationToken::new(), || {})
                        .is_err()
                );
                assert_eq!(fs::read(&path).unwrap(), bytes.as_bytes());
                fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
            }
        }
    }
    #[test]
    fn invalid_pattern_list_fails_closed_only_for_hosts_its_valid_patterns_match() {
        // OpenSSH honours the valid patterns of a list with a bad one; skipping the line would
        // lose a revocation or turn a changed pin into a trust prompt.
        let (key, other) = (key(1), key(2));
        let (k, o) = (key.to_openssh().unwrap(), other.to_openssh().unwrap());
        let malformed = Err(SessionError::KnownHostsMalformed { line: 2 });
        for (bytes, token, expected) in [
            (format!("# c\n@revoked host,,other {k}"), "host", malformed.clone()),
            (format!("# c\n@revoked host,,other {k}"), "other", malformed.clone()),
            (format!("# c\n@revoked host,,other {k}"), "else", Ok(Verdict::Unknown)),
            (format!("# c\nhost,bad/x {o}"), "host", malformed.clone()),
            (format!("# c\nhost,bad/x {o}"), "else", Ok(Verdict::Unknown)),
            (format!("# c\n!host,*,bad/x {o}"), "host", Ok(Verdict::Unknown)),
            (format!("# c\n!host,*,bad/x {o}"), "else", malformed.clone()),
        ] {
            assert_eq!(classify(bytes.as_bytes(), token, &key), expected, "{token}: {bytes}");
        }
    }
    #[test]
    fn hashed_host_and_bracket_port_match_openssh_fixture() {
        // Independently generated using Python hmac, not the matcher under test.
        let key = key(1);
        for (host, hash) in [
            (
                "host.example",
                "|1|AAECAwQFBgcICQoLDA0ODxAREhM=|DnpHtKjaC+vTmgwkAZCf9SqxJN8=",
            ),
            (
                "2001:db8::1",
                "|1|AAECAwQFBgcICQoLDA0ODxAREhM=|oOCWz5sN4wEqApl8GLxdXMOxqpQ=",
            ),
        ] {
            let bytes = format!("{hash} {}", key.to_openssh().unwrap());
            assert_eq!(
                classify(bytes.as_bytes(), &lookup_token(host, 2222), &key),
                Ok(Verdict::Verified)
            );
            assert_eq!(
                classify(bytes.as_bytes(), &lookup_token(host, 22), &key),
                Ok(Verdict::Unknown)
            );
        }
    }
    #[test]
    fn unrelated_broken_keys_do_not_block_verification_or_trust() {
        let key = key(1);
        let k = key.to_openssh().unwrap();
        let (_, blob) = k.split_once(' ').unwrap();
        let initial = format!("other ssh-ed25519 !!!\nother {blob}\nhost {k}\n");
        assert_eq!(classify(initial.as_bytes(), "host", &key), Ok(Verdict::Verified));

        let path = temporary();
        private_parent(&path).unwrap();
        fs::write(&path, &initial).unwrap();
        trust_transaction(&path, "new-host", &key, &CancellationToken::new(), || {}).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), format!("{initial}new-host {k}\n"));
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
    #[test]
    fn matching_broken_keys_fail_even_after_a_verified_key() {
        let key = key(1);
        let k = key.to_openssh().unwrap();
        let (_, blob) = k.split_once(' ').unwrap();
        for broken in [blob, "ssh-ed25519 !!!"] {
            let text = format!("host {k}\n# comment\nhost {broken}");
            assert_eq!(classify(text.as_bytes(), "host", &key), Err(SessionError::KnownHostsMalformed { line: 3 }));
        }
    }
    #[test]
    fn broken_hashed_entry_fails_only_for_its_host() {
        let key = key(1);
        let bytes = b"# comment\n|1|AAECAwQFBgcICQoLDA0ODxAREhM=|DnpHtKjaC+vTmgwkAZCf9SqxJN8= ssh-ed25519 !!!";
        assert_eq!(classify(bytes, "[host.example]:2222", &key), Err(SessionError::KnownHostsMalformed { line: 2 }));
        assert_eq!(classify(bytes, "[host.example]:22", &key), Ok(Verdict::Unknown));
    }
    #[test]
    fn accepts_utf8_bom() {
        let key = key(1);
        let text = format!("\u{feff}host {}", key.to_openssh().unwrap());
        assert_eq!(classify(text.as_bytes(), "host", &key), Ok(Verdict::Verified));
    }
    #[test]
    fn rejects_non_utf8_text() {
        let key = key(1);
        let text = format!("host {}", key.to_openssh().unwrap());
        let utf16: Vec<_> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let with_bom = [&[0xff, 0xfe][..], &utf16].concat();
        for bytes in [utf16.as_slice(), with_bom.as_slice(), &[0xff]] {
            assert_eq!(classify(bytes, "host", &key), Err(SessionError::KnownHostsMalformed { line: 0 }));
        }
    }
    #[test]
    fn different_algorithm_is_changed_not_tofu() {
        let rsa = include_str!("fixtures/client_rsa.pub");
        assert_eq!(
            classify(format!("host {rsa}").as_bytes(), "host", &key(1)),
            Err(SessionError::HostKeyChanged)
        );
        assert_eq!(
            classify(
                format!("host {rsa}\nhost {}", key(1).to_openssh().unwrap()).as_bytes(),
                "host",
                &key(1)
            ),
            Ok(Verdict::Verified)
        );
    }
    #[test]
    fn append_failure_and_cancel_never_release_launch() {
        let path = temporary();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            trust_transaction(&path, "host", &key(1), &cancel, || {}),
            Err(SessionError::Cancelled)
        );
        assert!(!path.exists());
        fs::create_dir(&path).unwrap();
        assert!(
            trust_transaction(&path, "host", &key(1), &CancellationToken::new(), || {}).is_err()
        );
        assert!(snapshot(&path).is_err());
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
    #[test]
    fn wildcard_negation_and_comma_hosts_match_correctly() {
        let key = key(1);
        let k = key.to_openssh().unwrap();
        let bytes = format!("*.example,!bad.example,other {k}");
        assert_eq!(
            classify(bytes.as_bytes(), "good.example", &key),
            Ok(Verdict::Verified)
        );
        assert_eq!(
            classify(bytes.as_bytes(), "bad.example", &key),
            Ok(Verdict::Unknown)
        );
        assert_eq!(
            classify(bytes.as_bytes(), "other", &key),
            Ok(Verdict::Verified)
        );
    }
    #[test]
    fn trust_appends_preserves_bytes_and_nondefault_token() {
        let path = temporary();
        private_parent(&path).unwrap();
        fs::write(&path, "# preserved").unwrap();
        #[cfg(unix)]
        let old_mode = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(&path).unwrap().permissions().mode() & 0o777
        };
        let key = key(1);
        let token = lookup_token("::1", 2222);
        trust_transaction(&path, &token, &key, &CancellationToken::new(), || {}).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("# preserved\n[::1]:2222 {}\n", key.to_openssh().unwrap())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                old_mode
            );
        }
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn unix_new_file_modes_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let path = temporary();
        trust_transaction(&path, "host", &key(1), &CancellationToken::new(), || {}).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
    #[test]
    fn two_writers_serialise_on_lock() {
        let path = temporary();
        private_parent(&path).unwrap();
        fs::write(&path, "# initial\n").unwrap();
        let (entered, arrived) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let first_path = path.clone();
        let first = std::thread::spawn(move || {
            trust_transaction(
                &first_path,
                "host",
                &key(1),
                &CancellationToken::new(),
                || {
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                },
            )
        });
        arrived.recv_timeout(Duration::from_secs(2)).unwrap();
        let (second_entered, second_arrived) = std::sync::mpsc::channel();
        let second_path = path.clone();
        let second = std::thread::spawn(move || {
            trust_transaction(
                &second_path,
                "host",
                &key(1),
                &CancellationToken::new(),
                || {
                    let _ = second_entered.send(());
                },
            )
        });
        let overlaps = second_arrived
            .recv_timeout(Duration::from_millis(80))
            .is_ok();
        release.send(()).unwrap();
        assert!(first.join().unwrap().is_ok());
        assert!(second.join().unwrap().is_err());
        assert!(
            !overlaps,
            "second writer entered while the first held the transaction lock"
        );
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
    #[test]
    fn replaced_file_between_read_and_append_refuses() {
        let path = temporary();
        private_parent(&path).unwrap();
        fs::write(&path, "# old\n").unwrap();
        let result = trust_transaction(&path, "host", &key(1), &CancellationToken::new(), || {
            fs::rename(&path, path.with_extension("old")).unwrap();
            fs::write(&path, "# replaced\n").unwrap();
        });
        assert_eq!(result, Err(SessionError::TrustWriteFailed));
        assert_eq!(fs::read_to_string(&path).unwrap(), "# replaced\n");
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
    #[test]
    fn same_key_concurrent_trust_appends_once() {
        let path = temporary();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let tasks: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    trust_transaction(&path, "host", &key(1), &CancellationToken::new(), || {
                        std::thread::sleep(Duration::from_millis(50))
                    })
                })
            })
            .collect();
        let results: Vec<_> = tasks.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 1);
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
    #[test]
    fn concurrent_revocation_between_prompt_and_trust_refuses() {
        let path = temporary();
        private_parent(&path).unwrap();
        let bytes = format!("@revoked host {}\n", key(1).to_openssh().unwrap());
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            trust_transaction(&path, "host", &key(1), &CancellationToken::new(), || {}),
            Err(SessionError::HostKeyRevoked)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
}
