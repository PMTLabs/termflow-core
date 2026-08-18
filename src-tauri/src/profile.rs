//! Profile identity. Everything mutable in the app is derived from a
//! ProfileIdentity so two instances never share a file, pipe, lock or port.
//! See design 009 and the rev-2 preamble of plan 011.

use std::sync::OnceLock;

pub const DEFAULT: &str = "default";
/// Auto-selected for an elevated launch when no profile is named.
pub const ELEVATED: &str = "elevated";

/// A default profile baked in at BUILD time (`TERMFLOW_PROFILE=alt tauri build`),
/// used when the launch names none. This is what makes the `:alt` package
/// scripts a genuinely separate instance: its config, history DB, layout,
/// recordings, lock, pipe and ports are all derived from the identity, so the
/// side-by-side build never touches the main build's data — without the user
/// remembering `--profile` on every launch.
///
/// `None` in every ordinary build, where the default profile is unchanged.
const BAKED: Option<&str> = option_env!("TERMFLOW_PROFILE");

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
        Self::resolve_with_baked(requested, BAKED, elevated, is_dev)
    }

    /// `baked` split out from the `option_env!` constant so the build-time
    /// default is testable without recompiling under a different environment.
    fn resolve_with_baked(
        requested: Option<&str>,
        baked: Option<&str>,
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
            // A bad baked value is a build mistake, not a user typo, so it gets
            // its own message -- but it still fails closed rather than falling
            // back to the default profile and writing the main build's files.
            None => match baked {
                Some(raw) => sanitize(raw).ok_or_else(|| {
                    format!("this build was compiled with an invalid TERMFLOW_PROFILE value {raw:?}")
                })?,
                None if integrity == Integrity::High => ELEVATED.to_string(),
                None => DEFAULT.to_string(),
            },
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

const ADMIN_TAG: &str = " [Administrator]";

/// Decorate a window or tray title for the current identity. Every window
/// builder AND `set_window_title` route through here — decorating only at
/// startup would lose the mark on the first tab change.
pub fn decorate_title(base: &str) -> String {
    current().decorate_title(base)
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
    /// The full identity key, including the channel. The renderer compares this
    /// against the `instance` field of an API response to prove it is talking to
    /// its OWN backend before acting on the terminals it lists.
    pub key: String,
}

impl ProfileIdentity {
    /// Mark a window or tray title with this instance's identity, so a user
    /// running several at once can tell them apart at a glance:
    ///
    /// - default, normal → unchanged
    /// - `work`          → `… (work)`
    /// - elevated        → `… [Administrator]`
    ///
    /// Idempotent: re-decorating an already-decorated title is a no-op, because
    /// the renderer round-trips titles through `set_window_title`.
    pub fn decorate_title(&self, base: &str) -> String {
        let mut out = base.to_string();
        if !is_default(&self.name) {
            let tag = format!(" ({})", self.name);
            if !out.ends_with(&tag) && !out.contains(&format!("{tag} [")) {
                out.push_str(&tag);
            }
        }
        if self.integrity == Integrity::High && !out.ends_with(ADMIN_TAG) {
            out.push_str(ADMIN_TAG);
        }
        out
    }

    pub fn info(&self) -> ProfileInfo {
        let elevated = self.integrity == Integrity::High;
        ProfileInfo {
            name: self.name.clone(),
            elevated,
            scope: format!("{}{}", self.name, if elevated { ".high" } else { "" }),
            is_default: is_default(&self.name) && !elevated,
            key: self.key(),
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

/// The CLI arguments a relaunch of THIS process must carry to come back as the
/// same instance (plan 018 Task 10).
///
/// The in-app updater relaunches with whatever it is given, and it was given
/// nothing — so `--profile work` came back as the DEFAULT profile: a different
/// config file, a different window registry, and an empty renderer storage
/// scope. To the user that reads as "the update ate my session".
///
/// Derived from the resolved identity rather than echoed from `std::env::args`,
/// which would also replay one-shot flags (`--path`, `--headless`) that must
/// not survive a restart.
///
/// Elevation is deliberately NOT expressed here. It is a property of the process
/// token, re-derived on launch, and the auto-selected `elevated` name comes with
/// it — passing `--profile elevated` to a process that came back at medium
/// integrity would mint a THIRD identity (`rel.elevated`) that owns nobody's
/// data.
pub fn relaunch_args(id: &ProfileIdentity) -> Vec<String> {
    if is_default(&id.name) {
        return Vec::new();
    }
    if id.name == ELEVATED && id.integrity == Integrity::High {
        // Auto-derived from the token, not requested. It will be derived again.
        return Vec::new();
    }
    vec!["--profile".to_string(), id.name.clone()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(name: &str, integrity: Integrity) -> ProfileIdentity {
        ProfileIdentity { channel: "rel", name: name.to_string(), integrity }
    }

    #[test]
    fn the_default_profile_relaunches_with_no_args() {
        // Byte-identical to today's behaviour for the overwhelmingly common case.
        assert!(relaunch_args(&identity(DEFAULT, Integrity::Medium)).is_empty());
    }

    #[test]
    fn a_named_profile_carries_itself_through_the_relaunch() {
        assert_eq!(
            relaunch_args(&identity("work", Integrity::Medium)),
            vec!["--profile".to_string(), "work".to_string()]
        );
    }

    #[test]
    fn a_named_profile_carries_through_even_when_elevated() {
        // The NAME was requested; only the integrity is re-derived.
        assert_eq!(
            relaunch_args(&identity("work", Integrity::High)),
            vec!["--profile".to_string(), "work".to_string()]
        );
    }

    #[test]
    fn the_auto_elevated_name_is_left_to_be_re_derived() {
        // `elevated` was never requested — it is what an elevated launch with no
        // --profile resolves to. Passing it explicitly to a process that came
        // back at medium integrity would mint `rel.elevated`, a third identity
        // owning nobody's data.
        assert!(relaunch_args(&identity(ELEVATED, Integrity::High)).is_empty());
    }

    #[test]
    fn an_explicitly_named_elevated_profile_at_medium_still_carries() {
        // Someone really did type `--profile elevated` and is not elevated.
        // Dropping it would silently move them to the default profile.
        assert_eq!(
            relaunch_args(&identity(ELEVATED, Integrity::Medium)),
            vec!["--profile".to_string(), ELEVATED.to_string()]
        );
    }

    #[test]
    fn every_relaunch_arg_survives_its_own_parser() {
        // The args go back through clap on the next launch; one that sanitize()
        // would reject is a relaunch that fails to start at all.
        for name in ["work", "build-2_x", ELEVATED] {
            let args = relaunch_args(&identity(name, Integrity::Medium));
            if args.is_empty() { continue; }
            assert_eq!(args[0], "--profile");
            assert_eq!(sanitize_arg(&args[1]).as_deref(), Ok(name));
        }
    }

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
    fn a_baked_profile_becomes_the_default_for_that_build() {
        // What makes the `:alt` build self-separating: no --profile on the
        // command line, yet every artifact is scoped away from the main build.
        let id = ProfileIdentity::resolve_with_baked(None, Some("alt"), Some(false), false).unwrap();
        assert_eq!(id.name, "alt");
        assert_eq!(id.key(), "rel.alt");
        assert_eq!(id.scoped_file("history.db"), "history.alt.db");
        assert_eq!(id.scoped_file("config.json"), "config.alt.json");
        // ...and it must not claim the machine-wide fabric singletons.
        assert!(!id.is_primary());
    }

    #[test]
    fn an_explicit_profile_still_beats_the_baked_one() {
        let id =
            ProfileIdentity::resolve_with_baked(Some("work"), Some("alt"), Some(false), false)
                .unwrap();
        assert_eq!(id.name, "work");
        // An elevated launch of a baked build keeps the baked name (as an
        // explicit one survives elevation), only gaining the integrity tag.
        let id = ProfileIdentity::resolve_with_baked(None, Some("alt"), Some(true), false).unwrap();
        assert_eq!(id.key(), "rel.alt.high");
    }

    #[test]
    fn an_invalid_baked_profile_refuses_to_launch() {
        // Falling back to the default would silently write the MAIN build's
        // config and history -- the exact collision the baked value exists to
        // prevent.
        assert!(ProfileIdentity::resolve_with_baked(None, Some("../etc"), Some(false), false)
            .is_err());
        assert!(ProfileIdentity::resolve_with_baked(None, Some(""), Some(false), false).is_err());
    }

    /// Every `TERMFLOW_PROFILE=<name>` the package scripts bake in, first-seen
    /// order, deduplicated (each profile has both a build and a publish script).
    ///
    /// Read from `package.json` itself rather than restated here: the build
    /// script is the only place a profile name is declared, and nothing else
    /// connects that string to the sanitiser every derived path, pipe, lock and
    /// port name depends on. A name added there that this module would refuse
    /// produces a build whose every launch fails closed -- so the roster is
    /// checked at test time instead of at the user's first launch.
    fn baked_profile_names() -> Vec<&'static str> {
        const PACKAGE_JSON: &str = include_str!("../../package.json");
        const MARKER: &str = "TERMFLOW_PROFILE=";
        let mut out: Vec<&'static str> = Vec::new();
        for (at, _) in PACKAGE_JSON.match_indices(MARKER) {
            let rest = &PACKAGE_JSON[at + MARKER.len()..];
            // The name runs to the first character `sanitize` would reject --
            // in practice the space before `tauri build`.
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .unwrap_or(rest.len());
            let name = &rest[..end];
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        }
        out
    }

    #[test]
    fn every_baked_build_profile_is_valid_and_isolated() {
        let names = baked_profile_names();
        // The side-by-side builds this repo ships. Adding a `:<name>` script
        // pair means adding it here too -- which is what drags the new name
        // through the sanitiser and the distinctness checks below.
        for expected in ["alt", "nightly"] {
            assert!(
                names.contains(&expected),
                "package.json should bake TERMFLOW_PROFILE={expected}; found {names:?}"
            );
        }

        // Isolation is what a profile IS: no baked build may share an identity
        // key (lock, pipe, host record, port claim) or a config filename with
        // the default build or with a sibling.
        let default =
            ProfileIdentity { channel: "rel", name: DEFAULT.into(), integrity: Integrity::Medium };
        let mut keys = vec![default.key()];
        let mut configs = vec![default.scoped_file("config.json")];
        for name in &names {
            let id = ProfileIdentity::resolve_with_baked(None, Some(name), Some(false), false)
                .unwrap_or_else(|e| {
                    panic!("package.json bakes TERMFLOW_PROFILE={name}, which fails to resolve: {e}")
                });
            assert_eq!(id.name.as_str(), *name, "a baked name must survive verbatim");
            // A baked profile must never claim the machine-wide fabric
            // singletons the default instance owns.
            assert!(!id.is_primary(), "{name} must not be the primary instance");
            keys.push(id.key());
            configs.push(id.scoped_file("config.json"));
        }

        let want = names.len() + 1; // every baked profile, plus the default
        let uniq = |mut v: Vec<String>| {
            v.sort();
            v.dedup();
            v.len()
        };
        assert_eq!(uniq(keys.clone()), want, "identity keys collide: {keys:?}");
        assert_eq!(uniq(configs.clone()), want, "config filenames collide: {configs:?}");
    }

    #[test]
    fn no_baked_profile_leaves_todays_defaults_alone() {
        assert_eq!(
            ProfileIdentity::resolve_with_baked(None, None, Some(false), false).unwrap().name,
            DEFAULT
        );
        assert_eq!(
            ProfileIdentity::resolve_with_baked(None, None, Some(true), false).unwrap().name,
            ELEVATED
        );
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
    fn titles_are_marked_for_every_identity_but_the_default() {
        let id = |n: &str, i| ProfileIdentity { channel: "rel", name: n.into(), integrity: i };
        assert_eq!(id("default", Integrity::Medium).decorate_title("TermFlow"), "TermFlow");
        assert_eq!(id("work", Integrity::Medium).decorate_title("TermFlow"), "TermFlow (work)");
        assert_eq!(
            id("default", Integrity::High).decorate_title("TermFlow"),
            "TermFlow [Administrator]"
        );
        assert_eq!(
            id("work", Integrity::High).decorate_title("TermFlow"),
            "TermFlow (work) [Administrator]"
        );
        // The decorator runs on the ACTIVE TAB title, not a fixed app name.
        assert_eq!(
            id("work", Integrity::Medium).decorate_title(r"pwsh - D:\src"),
            r"pwsh - D:\src (work)"
        );
    }

    #[test]
    fn decorating_twice_does_not_stack_the_marks() {
        // The renderer round-trips titles through set_window_title, so a title
        // that has already been through here can come back.
        let work = ProfileIdentity { channel: "rel", name: "work".into(), integrity: Integrity::High };
        let once = work.decorate_title("TermFlow");
        assert_eq!(work.decorate_title(&once), once);
        let medium = ProfileIdentity { channel: "rel", name: "work".into(), integrity: Integrity::Medium };
        let once = medium.decorate_title("TermFlow");
        assert_eq!(medium.decorate_title(&once), once);
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
