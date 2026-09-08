    use super::*;

    // Design §12: this codebase has already shipped a silent serde-key misroute once (the
    // Fleet MCP `targetOS` bug), where a field deserialised to None and the feature simply
    // did nothing. `parent_terminal_id` fails exactly that way — the spawn still succeeds and
    // only the edge is missing.

    #[test]
    fn accepts_the_camel_case_wire_name() {
        let r: CreateTerminalReq =
            serde_json::from_str(r#"{"parentTerminalId":"pc-abc"}"#).unwrap();
        assert_eq!(r.parent_terminal_id.as_deref(), Some("pc-abc"));
    }

    #[test]
    fn accepts_the_snake_case_name() {
        let r: CreateTerminalReq =
            serde_json::from_str(r#"{"parent_terminal_id":"pc-abc"}"#).unwrap();
        assert_eq!(r.parent_terminal_id.as_deref(), Some("pc-abc"));
    }

    #[test]
    fn absent_parent_is_none_not_an_error() {
        let r: CreateTerminalReq = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert!(r.parent_terminal_id.is_none());
    }

    #[test]
    fn the_parent_field_does_not_disturb_the_tab_targeting_fields() {
        // The MCP hop sends owningTabId, paneId and direction alongside the new field. A
        // rename or a missing alias here is invisible at the HTTP boundary: the request still
        // deserialises, and the pane just lands in the wrong tab.
        let r: CreateTerminalReq = serde_json::from_str(
            r#"{"owningTabId":"tb-1","paneId":"tm-2","direction":"horizontal","parentTerminalId":"pc-3"}"#,
        )
        .unwrap();
        assert_eq!(r.owning_tab_id.as_deref(), Some("tb-1"));
        assert_eq!(r.pane_id.as_deref(), Some("tm-2"));
        assert_eq!(r.direction.as_deref(), Some("horizontal"));
        assert_eq!(r.parent_terminal_id.as_deref(), Some("pc-3"));
    }
