//! Opaque identities for one shell run. Neither timestamps nor shortened ids
//! are sufficient: a delayed request must never name a replacement shell.

use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct IdAllocator {
    draw: Arc<dyn Fn() -> Result<Uuid, String> + Send + Sync>,
}

impl Default for IdAllocator {
    fn default() -> Self {
        Self::new(|| {
            // uuid uses the OS CSPRNG but exposes its failure as a panic. Turn
            // that failure into a create error, without a weaker fallback.
            std::panic::catch_unwind(Uuid::new_v4)
                .map_err(|_| "could not obtain randomness for shell identity".to_string())
        })
    }
}

impl IdAllocator {
    pub fn new(draw: impl Fn() -> Result<Uuid, String> + Send + Sync + 'static) -> Self {
        Self { draw: Arc::new(draw) }
    }

    fn suffix(&self) -> Result<String, String> {
        let id = (self.draw)()?;
        if id.get_version() != Some(uuid::Version::Random) || id.get_variant() != uuid::Variant::RFC4122 {
            return Err("shell identity generator did not produce a UUID v4".to_string());
        }
        Ok(id.simple().to_string())
    }

    pub fn mint_process_id(&self) -> Result<String, String> {
        Ok(format!("pc-{}", self.suffix()?))
    }

    pub fn mint_session_key(&self, leaf: &str) -> Result<String, String> {
        if leaf.is_empty() || leaf.contains('~') {
            return Err("invalid leaf for shell session identity".to_string());
        }
        Ok(format!("{leaf}~{}", self.suffix()?))
    }
}

pub fn mint_process_id() -> Result<String, String> {
    IdAllocator::default().mint_process_id()
}

pub fn mint_session_key(leaf: &str) -> Result<String, String> {
    IdAllocator::default().mint_session_key(leaf)
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionKeyKind<'a> {
    V2 { owner_leaf: &'a str },
    Legacy,
}

pub fn parse_session_key(key: &str) -> SessionKeyKind<'_> {
    if let Some((leaf, suffix)) = key.rsplit_once('~') {
        if !leaf.is_empty() && !leaf.contains('~') && suffix.len() == 32
            && suffix.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return SessionKeyKind::V2 { owner_leaf: leaf };
        }
    }
    SessionKeyKind::Legacy
}

/// Select only eligible listed keys. Ambiguity among own-leaf sessions is not
/// resolved by an override: all of them remain recoverable and a new run starts.
pub fn restore_candidate<'a>(
    leaf: &str,
    override_key: Option<&str>,
    eligible: impl IntoIterator<Item = &'a str>,
) -> Option<&'a str> {
    let keys: Vec<_> = eligible.into_iter().collect();
    let mut own = keys.iter().copied().filter(|key| {
        parse_session_key(key) == SessionKeyKind::V2 { owner_leaf: leaf }
    });
    if let Some(first) = own.next() {
        return if own.next().is_none() { Some(first) } else { None };
    }
    override_key.and_then(|key| keys.iter().copied().find(|k| *k == key))
        .or_else(|| keys.iter().copied().find(|key| *key == leaf && parse_session_key(key) == SessionKeyKind::Legacy))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_preserve_all_uuid_bits_and_fail_closed() {
        let known = Uuid::parse_str("01234567-89ab-4cde-8fab-0123456789ab").unwrap();
        let ids = IdAllocator::new(move || Ok(known));
        assert_eq!(ids.mint_process_id().unwrap(), "pc-0123456789ab4cde8fab0123456789ab");
        assert_eq!(ids.mint_session_key("tm-leaf").unwrap(), "tm-leaf~0123456789ab4cde8fab0123456789ab");
        let fail = IdAllocator::new(|| Err("rng unavailable".into()));
        assert_eq!(fail.mint_process_id(), Err("rng unavailable".into()));
        assert_eq!(fail.mint_session_key("tm-leaf"), Err("rng unavailable".into()));
        let invalid = IdAllocator::new(|| Ok(Uuid::nil()));
        assert!(invalid.mint_process_id().is_err());
        assert!(ids.mint_session_key("").is_err());
        assert!(ids.mint_session_key("tm~leaf").is_err());
        let a = mint_process_id().unwrap();
        let b = mint_process_id().unwrap();
        assert!(regex::Regex::new(r"^pc-[0-9a-f]{32}$").unwrap().is_match(&a));
        assert_ne!(a, b);
        let a = mint_session_key("tm-leaf").unwrap();
        let b = mint_session_key("tm-leaf").unwrap();
        assert_ne!(a, b);
        assert!(regex::Regex::new(r"^tm-leaf~[0-9a-f]{32}$").unwrap().is_match(&a));
    }

    #[test]
    fn session_key_parse_table() {
        let suffix = "0123456789ab4cde8fab0123456789ab";
        assert_eq!(parse_session_key(&format!("tm-leaf~{suffix}")), SessionKeyKind::V2 { owner_leaf: "tm-leaf" });
        for key in ["tm-leaf".to_string(), "legacy-leaf".to_string(), "".to_string(),
            format!("~{suffix}"), format!("tm~leaf~{suffix}"), format!("tm-leaf~{}", suffix.to_uppercase()),
            format!("tm-leaf~{}", &suffix[..31]), format!("tm-leaf~{suffix}0"), "tm-leaf~".to_string()]
        {
            assert_eq!(parse_session_key(&key), SessionKeyKind::Legacy, "{key}");
        }
    }

    #[test]
    fn precedence_distinguishes_automatic_discovery_from_exact_overrides() {
        let own = "tm-leaf~0123456789ab4cde8fab0123456789ab";
        let second = "tm-leaf~0123456789ab4cde8fab0123456789ac";
        let other = "tm-other~0123456789ab4cde8fab0123456789ab";
        assert_eq!(restore_candidate("tm-leaf", Some(other), [own, other, "tm-leaf"]), Some(own));
        assert_eq!(restore_candidate("tm-leaf", Some(other), [own, second, other, "tm-leaf"]), None);
        assert_eq!(restore_candidate("tm-leaf", None, [other]), None);
        assert_eq!(restore_candidate("tm-leaf", Some(other), [other, "tm-leaf"]), Some(other));
        assert_eq!(restore_candidate("tm-leaf", None, ["tm-leaf"]), Some("tm-leaf"));
        assert_eq!(restore_candidate("tm-leaf", Some("missing"), ["tm-leaf"]), Some("tm-leaf"));
    }
}
