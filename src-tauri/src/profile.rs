//! Profile identity. Everything mutable in the app is derived from a
//! ProfileIdentity so two instances never share a file, pipe, lock or port.
//! See design 009 and the rev-2 preamble of plan 011.

pub const DEFAULT: &str = "default";
/// Auto-selected for an elevated launch when no profile is named.
pub const ELEVATED: &str = "elevated";

/// Accept a profile name only if it is safe as a single path component and as
/// part of a Win32 object name. A security boundary, not a convenience: the
/// value reaches `Path::join`, a named-pipe name and a mutex name.
pub fn sanitize(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 32 {
        return None;
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    Some(name.to_ascii_lowercase())
}

pub fn is_default(name: &str) -> bool {
    name == DEFAULT
}

/// clap adaptor: reject at parse time so a typo never reaches path building.
pub fn sanitize_arg(raw: &str) -> Result<String, String> {
    sanitize(raw).ok_or_else(|| {
        format!("profile names may contain only a-z, 0-9, '-' and '_' (max 32 chars); got {raw:?}")
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Integrity {
    Medium,
    High,
}

impl Integrity {
    /// Short tag used in every derived name.
    pub fn tag(self) -> &'static str {
        match self {
            Integrity::Medium => "",
            Integrity::High => ".high",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileIdentity {
    pub channel: &'static str, // "dev" | "rel"
    pub name: String,
    pub integrity: Integrity,
}

impl ProfileIdentity {
    /// Stable key for locks, pipes and records. Empty extra components for
    /// (rel, default, medium) so every legacy name is byte-identical.
    pub fn key(&self) -> String {
        let profile = if is_default(&self.name) {
            String::new()
        } else {
            format!(".{}", self.name)
        };
        format!("{}{}{}", self.channel, profile, self.integrity.tag())
    }

    /// `elevated` is Option: None means the token query FAILED. Treating that as
    /// "medium" would hand an elevated process the default identity, so it is an
    /// error instead.
    pub fn resolve(
        requested: Option<&str>,
        elevated: Option<bool>,
        is_dev: bool,
    ) -> Result<Self, String> {
        let integrity = match elevated {
            Some(true) => Integrity::High,
            Some(false) => Integrity::Medium,
            None => return Err("could not determine process elevation; refusing to launch".into()),
        };
        let name = match requested {
            Some(raw) => sanitize(raw).ok_or_else(|| format!("invalid --profile value {raw:?}"))?,
            None if integrity == Integrity::High => ELEVATED.to_string(),
            None => DEFAULT.to_string(),
        };
        Ok(Self {
            channel: if is_dev { "dev" } else { "rel" },
            name,
            integrity,
        })
    }
}

/// `Some(true|false)` when the token was readable, `None` when it was not.
#[cfg(windows)]
pub fn elevation() -> Option<bool> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return None;
        }
        let mut e = TOKEN_ELEVATION::default();
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut e as *mut _ as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if ok {
            Some(e.TokenIsElevated != 0)
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
pub fn elevation() -> Option<bool> {
    Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_names_are_accepted_and_normalised() {
        assert_eq!(sanitize("work").as_deref(), Some("work"));
        assert_eq!(sanitize("  Work  ").as_deref(), Some("work"));
        assert_eq!(sanitize("build-2_x").as_deref(), Some("build-2_x"));
    }

    #[test]
    fn path_traversal_is_rejected() {
        assert_eq!(sanitize(".."), None);
        assert_eq!(sanitize("../../windows"), None);
        assert_eq!(sanitize("a/b"), None);
        assert_eq!(sanitize(r"a\b"), None);
        assert_eq!(sanitize("a:b"), None);
    }

    #[test]
    fn empty_overlong_and_exotic_names_are_rejected() {
        assert_eq!(sanitize(""), None);
        assert_eq!(sanitize("   "), None);
        assert_eq!(sanitize(&"x".repeat(33)), None);
        assert_eq!(sanitize("prof ile"), None);
        assert_eq!(sanitize("café"), None);
    }

    #[test]
    fn an_explicit_profile_always_wins() {
        let id = ProfileIdentity::resolve(Some("work"), Some(false), false).unwrap();
        assert_eq!(id.name, "work");
        let id = ProfileIdentity::resolve(Some("work"), Some(true), false).unwrap();
        assert_eq!(id.name, "work");
        // The profile survives elevation -- rev 1 collapsed every elevated
        // profile to "elevated", so `work` and `admin2` shared one lock.
        assert_eq!(id.integrity, Integrity::High);
    }

    #[test]
    fn elevation_selects_its_own_profile_when_none_is_named() {
        assert_eq!(ProfileIdentity::resolve(None, Some(true), false).unwrap().name, ELEVATED);
        assert_eq!(ProfileIdentity::resolve(None, Some(false), false).unwrap().name, DEFAULT);
    }

    #[test]
    fn an_invalid_explicit_profile_is_an_error_not_a_fallback() {
        // Rev 1 fell back silently, so a typo could focus or mutate the WRONG
        // profile. Refusing to launch is the safe failure.
        assert!(ProfileIdentity::resolve(Some("../etc"), Some(false), false).is_err());
        assert!(ProfileIdentity::resolve(Some(""), Some(false), false).is_err());
    }

    #[test]
    fn indeterminate_elevation_fails_closed() {
        // Rev 1 treated a failed token query as "not elevated", which would let
        // an elevated process take the DEFAULT identity, lock and pipe.
        assert!(ProfileIdentity::resolve(None, None, false).is_err());
    }

    #[test]
    fn identity_keys_are_distinct_across_every_dimension() {
        let k = |n: &str, i| ProfileIdentity { channel: "rel", name: n.to_string(), integrity: i }.key();
        let all = [k("default", Integrity::Medium), k("default", Integrity::High),
                   k("work", Integrity::Medium), k("work", Integrity::High)];
        let mut uniq = all.to_vec();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), 4, "every dimension must change the key: {all:?}");
    }
}
