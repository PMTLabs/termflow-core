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
}
