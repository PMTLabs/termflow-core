//! Profile identity. Everything mutable in the app is derived from a
//! ProfileIdentity so two instances never share a file, pipe, lock or port.
//! See design 009 and the rev-2 preamble of plan 011.

use std::sync::OnceLock;

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

impl ProfileIdentity {
    /// Everything that distinguishes this identity from the default one, as a
    /// dotted suffix. Empty for (default, medium) — that is what keeps every
    /// legacy filename byte-identical.
    fn suffix(&self) -> String {
        let mut extra = String::new();
        if !is_default(&self.name) {
            extra.push('.');
            extra.push_str(&self.name);
        }
        if self.integrity == Integrity::High {
            extra.push_str(".high");
        }
        extra
    }

    /// Suffix a filename with everything that distinguishes this identity,
    /// leaving (default, medium) untouched. Composes with the existing
    /// `app_config::dev_file` channel convention rather than replacing it.
    pub fn scoped_file(&self, name: &str) -> String {
        let extra = self.suffix();
        if extra.is_empty() {
            return name.to_string();
        }
        match name.rsplit_once('.') {
            Some((stem, ext)) => format!("{stem}{extra}.{ext}"),
            None => format!("{name}{extra}"),
        }
    }

    /// True for the one instance per channel that owns the machine-wide
    /// singletons no filename suffix can separate — today the peering fabric's
    /// keychain identity and its peer listener.
    pub fn is_primary(&self) -> bool {
        is_default(&self.name) && self.integrity == Integrity::Medium
    }

    /// Dot-free variant for consumers that treat the last dot as an extension
    /// boundary. `tauri-plugin-log` calls `with_extension("log")` on the name it
    /// is handed (`RotatingFile::new`), so `TermFlow.work` would collapse back
    /// to `TermFlow.log` and two profiles would share one rotating file.
    pub fn scoped_stem(&self, stem: &str) -> String {
        format!("{stem}{}", self.suffix().replace('.', "-"))
    }
}

static CURRENT: OnceLock<ProfileIdentity> = OnceLock::new();

/// Called once from `run()` immediately after argument parsing, before any path
/// is resolved.
pub fn set_current(id: ProfileIdentity) {
    let _ = CURRENT.set(id);
}

pub fn current() -> &'static ProfileIdentity {
    // Unit tests exercise path helpers without going through `run()`; they all
    // mean the default identity. Production stays fail-loud: resolving a path
    // before the identity is known would write to the wrong profile.
    #[cfg(test)]
    {
        CURRENT.get_or_init(|| ProfileIdentity {
            channel: if crate::app_config::is_dev() { "dev" } else { "rel" },
            name: DEFAULT.to_string(),
            integrity: Integrity::Medium,
        })
    }
    #[cfg(not(test))]
    {
        CURRENT
            .get()
            .expect("profile::set_current must run before any path is resolved")
    }
}

/// Scope a mutable artifact's filename to the current identity.
pub fn scoped_file(name: &str) -> String {
    current().scoped_file(name)
}

/// What the renderer needs: which profile this window belongs to, and the
/// discriminator its storage keys hang off. Two instances share one WebView2
/// user-data folder — hence one localStorage — so the renderer cannot work this
/// out for itself.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub elevated: bool,
    /// `name`, plus `.high` when elevated. `"default"` keeps today's keys.
    pub scope: String,
    pub is_default: bool,
}

impl ProfileIdentity {
    pub fn info(&self) -> ProfileInfo {
        let elevated = self.integrity == Integrity::High;
        ProfileInfo {
            name: self.name.clone(),
            elevated,
            scope: format!("{}{}", self.name, if elevated { ".high" } else { "" }),
            is_default: is_default(&self.name) && !elevated,
        }
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
    fn the_default_identity_reproduces_todays_names_exactly() {
        let id = ProfileIdentity { channel: "rel", name: DEFAULT.into(), integrity: Integrity::Medium };
        // Non-negotiable (D7): not one existing user's file may move.
        assert_eq!(id.scoped_file("config.json"), "config.json");
        assert_eq!(id.scoped_file("history.db"), "history.db");
        assert_eq!(id.scoped_file("layout.json"), "layout.json");
        assert_eq!(id.scoped_file("recordings"), "recordings");
        assert_eq!(id.key(), "rel");
    }

    #[test]
    fn a_named_or_elevated_identity_suffixes_every_artifact() {
        let work = ProfileIdentity { channel: "rel", name: "work".into(), integrity: Integrity::Medium };
        assert_eq!(work.scoped_file("config.json"), "config.work.json");
        assert_eq!(work.scoped_file("recordings"), "recordings.work");

        let admin = ProfileIdentity { channel: "rel", name: ELEVATED.into(), integrity: Integrity::High };
        assert_eq!(admin.scoped_file("config.json"), "config.elevated.high.json");
    }

    #[test]
    fn every_default_artifact_name_is_unchanged_from_before_profiles() {
        // Guards the whole D7 promise in one place. If a future change routes a
        // new file through the resolver, add it here FIRST.
        let id = ProfileIdentity { channel: "rel", name: DEFAULT.into(), integrity: Integrity::Medium };
        for name in ["config.json", "config.dev.json", "history.db", "history.dev.db",
                     "layout.json", "recordings", "search_index.json", "profiles.json"] {
            assert_eq!(id.scoped_file(name), name, "default profile must not move {name}");
        }
        assert_eq!(id.scoped_stem("TermFlow"), "TermFlow");
    }

    #[test]
    fn only_the_default_medium_identity_is_primary() {
        // The fabric's keypair and peer port are machine-wide, so exactly one
        // instance per channel may own them.
        let id = |n: &str, i| ProfileIdentity { channel: "rel", name: n.into(), integrity: i };
        assert!(id("default", Integrity::Medium).is_primary());
        assert!(!id("default", Integrity::High).is_primary());
        assert!(!id("work", Integrity::Medium).is_primary());
    }

    #[test]
    fn a_scoped_stem_never_introduces_a_dot() {
        // tauri-plugin-log calls `with_extension("log")` on the name it is given
        // (RotatingFile::new), so "TermFlow.work" would collapse straight back to
        // "TermFlow.log" and two profiles would share one rotating file.
        let work = ProfileIdentity { channel: "rel", name: "work".into(), integrity: Integrity::High };
        let stem = work.scoped_stem("TermFlow");
        assert!(!stem.contains('.'), "got: {stem}");
        assert_eq!(stem, "TermFlow-work-high");
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
