    use super::{classify_terminal_ref, TerminalRef};
    use axum::http::StatusCode;

    /// A tab id where a terminal is meant — THE reported MCP failure. Before
    /// design 014 this could not even be DETECTED: a renderer-created tab's root
    /// leaf WAS its tab id, so `tb-…` was a legitimate terminal reference for
    /// some panes and meaningless for others, and an agent in a two-pane tab had
    /// no way to say which terminal it meant.
    #[test]
    fn a_tab_id_is_rejected_and_names_the_field_to_use_instead() {
        let err = classify_terminal_ref("tb-4e8d0c2f1").expect_err("a tab id is not a terminal");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("TAB id"), "must say what it IS: {}", err.1);
        assert!(err.1.contains("owningTabId"), "must name the right field: {}", err.1);
        assert!(err.1.contains("tm-"), "must name the right id space: {}", err.1);
    }

    #[test]
    fn a_pane_id_is_rejected_and_names_the_field_to_use_instead() {
        let err = classify_terminal_ref("pn-4k2j9x1qa").expect_err("a pane id is not a terminal");
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.contains("PANE id"), "{}", err.1);
        assert!(err.1.contains("tm-"), "{}", err.1);
    }

    #[test]
    fn a_leaf_id_classifies_as_the_durable_space() {
        assert_eq!(classify_terminal_ref("tm-9f2c1a4b7").unwrap(), TerminalRef::Leaf);
    }

    #[test]
    fn a_process_id_classifies_as_the_per_run_space() {
        assert_eq!(classify_terminal_ref("pc-abc123def").unwrap(), TerminalRef::Process);
    }

    /// Rejection is by SHAPE, not by liveness: a tab id matching nothing live
    /// must still be told it is a tab id, or the caller retries the same
    /// mistake with no idea why it failed.
    #[test]
    fn a_tab_id_is_rejected_even_when_nothing_is_live() {
        assert_eq!(classify_terminal_ref("tb-anything").unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    /// An id from before the prefixes existed must still route rather than 400 —
    /// rejecting it would break clients holding ids from an older build.
    #[test]
    fn an_unprefixed_legacy_id_is_treated_as_a_process_id() {
        assert_eq!(classify_terminal_ref("legacy-id-0001").unwrap(), TerminalRef::Process);
    }

    /// The prefixes must not leak onto ids that merely start similarly.
    #[test]
    fn the_prefix_rules_are_exact() {
        assert_eq!(classify_terminal_ref("tbx-0000").unwrap(), TerminalRef::Process);
        assert_eq!(classify_terminal_ref("pnx-0000").unwrap(), TerminalRef::Process);
        assert_eq!(classify_terminal_ref("tmx-0000").unwrap(), TerminalRef::Process);
    }
