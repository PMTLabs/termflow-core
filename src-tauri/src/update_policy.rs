//! Which way an update is applied, as decided by the release itself.
//!
//! Offload keeps every terminal alive across the update; Full closes them all. A
//! release that changes something an Offload cannot carry across (a host that
//! cannot talk to the old one, a changed on-disk format) says so in its notes:
//!
//! ```text
//! <!-- termflow: offload-from=MAJOR.MINOR.PATCH -->
//! ```
//!
//! Read as "a build older than MAJOR.MINOR.PATCH cannot survive an Offload into
//! this release", so updating FROM such a build is a Full update; from that
//! version or newer it is an Offload. Anything that does not say so clearly is
//! an Offload: a mistyped marker must never close someone's terminals.
//!
//! Pure over its two inputs. The marker is read by the OLD app, so it only takes
//! effect for updates performed from a build that already contains this reader.

/// How an update is applied, judged by the release notes alone. Crosses to the
/// renderer as `"offload"` / `"full"` and comes back the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateMode {
    /// Keep terminals alive across the update (the default).
    Offload,
    /// The notes demand a confirmed restart that closes every terminal.
    Full,
}

/// `running` is the version of the build performing the update, `notes` the
/// release notes of the downloaded target.
pub fn update_mode(running: &str, notes: Option<&str>) -> UpdateMode {
    let Some(floor) = notes.and_then(offload_from) else {
        return UpdateMode::Offload;
    };
    let Some(running) = Version::parse(running) else {
        // A dev or otherwise unparsable build cannot be shown to be older.
        return UpdateMode::Offload;
    };
    if running < floor {
        UpdateMode::Full
    } else {
        UpdateMode::Offload
    }
}

/// The version named by the FIRST `termflow: offload-from` comment in `notes`.
/// `None` when there is no such comment or its value is not a plain
/// `MAJOR.MINOR.PATCH`. A malformed first marker is not skipped in favour of a
/// later well-formed one: the first occurrence is the maintainer's statement and
/// a typo in it must fail toward Offload, not toward whatever follows.
///
/// No Markdown awareness: a marker inside a fenced code block counts, so a
/// release note that wants to show the syntax must not write it verbatim.
fn offload_from(notes: &str) -> Option<Version> {
    let mut rest = notes;
    while let Some(open) = rest.find("<!--") {
        let after = &rest[open + "<!--".len()..];
        // An unterminated comment ends the search; nothing after it is a comment.
        let close = after.find("-->")?;
        if let Some(value) = marker_value(&after[..close]) {
            return Version::parse_release(value);
        }
        rest = &after[close + "-->".len()..];
    }
    None
}

/// The text after `=` when `body` (the inside of one comment) is a
/// `termflow: offload-from` marker, whatever follows the key. Whitespace around
/// the tokens and the case of `termflow` and the key are not significant.
/// `Some("")` for a marker with no `=`, so the caller treats it as the (malformed)
/// first occurrence rather than looking further.
fn marker_value(body: &str) -> Option<&str> {
    let body = strip_prefix_ci(body.trim_start(), "termflow")?.trim_start();
    let body = body.strip_prefix(':')?.trim_start();
    let body = strip_prefix_ci(body, "offload-from")?.trim_start();
    Some(body.strip_prefix('=').map_or("", str::trim))
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    // `get` rather than slicing: `prefix` is ASCII, so if the first bytes equal it
    // the cut is on a char boundary, and a non-ASCII byte there yields `None`.
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
}

/// A semantic version reduced to what ordering needs. A pre-release sorts before
/// its own release (`1.2.3-beta.1 < 1.2.3`); two pre-releases of the same core
/// compare equal, which no decision here depends on. Build metadata is ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    /// `true` sorts AFTER `false`, so a release is newer than its pre-release.
    is_release: bool,
}

impl Version {
    /// `MAJOR.MINOR.PATCH` with an optional `-prerelease` and `+build` suffix.
    /// Strict: three numeric fields, no leading `v`, no leading zeros.
    fn parse(s: &str) -> Option<Self> {
        let (rest, build) = match s.split_once('+') {
            Some((rest, build)) => (rest, Some(build)),
            None => (s, None),
        };
        if !build.is_none_or(identifiers) {
            return None;
        }
        let (core, pre) = match rest.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (rest, None),
        };
        if !pre.is_none_or(identifiers) {
            return None;
        }
        let mut parts = core.split('.');
        let (major, minor, patch) = (
            numeric(parts.next()?)?,
            numeric(parts.next()?)?,
            numeric(parts.next()?)?,
        );
        if parts.next().is_some() {
            return None;
        }
        Some(Self { major, minor, patch, is_release: pre.is_none() })
    }

    /// The marker's own value: a plain release version, nothing appended.
    fn parse_release(s: &str) -> Option<Self> {
        if s.contains(['-', '+']) {
            return None;
        }
        Self::parse(s)
    }
}

/// Dot-separated, non-empty `[0-9A-Za-z-]` identifiers (a pre-release or build suffix).
fn identifiers(s: &str) -> bool {
    s.split('.')
        .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

fn numeric(field: &str) -> Option<u64> {
    let plain = !field.is_empty()
        && field.bytes().all(|b| b.is_ascii_digit())
        && (field.len() == 1 || !field.starts_with('0'));
    if plain { field.parse().ok() } else { None }
}

#[cfg(test)]
mod tests;
