    use super::*;

    fn identity_sample() -> crate::state::Terminal {
        crate::state::Terminal {
            id: "pc-abc123def".into(),
            pid: 4242,
            shell: "pwsh".into(),
            name: "Terminal-pwsh".into(),
            created_at: "2026-08-14T10:00:00+07:00".into(),
            cols: 120,
            rows: 40,
            backend: crate::tmux_manager::TerminalBackend::PortablePty,
            renderer_terminal_id: Some("tm-9f2c1a4b7".into()),
            owning_tab_id: Some("tb-4e8d0c2f1".into()),
            session_key: "tm-9f2c1a4b7".into(),
            last_input_source: None,
            last_input_at: None,
            prompt_hook: true,
            display_label: None,
        }
    }

    /// The canvas `node` block belongs to `GET /api/terminals/:id` ALONE.
    ///
    /// `terminal_identity_json` has three call sites, and `list_terminals` is one of them. If
    /// the block were built in here it would take the canvas-registry read lock and run a
    /// SQLite query once PER TERMINAL on every list call — for a field that endpoint was never
    /// asked to carry, and that no client reads from it. `plan/013` Task 19 described the
    /// change as "after building the existing JSON", which reads as though the handler builds
    /// its own object; it does not.
    #[test]
    fn the_shared_identity_payload_carries_no_canvas_node_block() {
        let v = terminal_identity_json(&identity_sample(), "ui");
        assert!(
            v.get("node").is_none(),
            "the node block must be merged at the get_terminal call site, not here —              otherwise list_terminals pays for it on every entry"
        );
    }

    /// Exact key names, asserted (design 011 §7 test 4). `tabId` stays a
    /// DEPRECATED alias of `terminalId` — redefining it would silently break
    /// every existing API/MCP client (D4).
    #[test]
    fn an_identity_response_carries_all_three_ids_under_exact_keys() {
        let v = terminal_identity_json(&identity_sample(), "ui");
        assert_eq!(v["id"], json!("pc-abc123def"));
        assert_eq!(v["processId"], json!("pc-abc123def"));
        assert_eq!(v["terminalId"], json!("tm-9f2c1a4b7"));
        assert_eq!(v["tabId"], json!("tm-9f2c1a4b7"));
        assert_eq!(v["owningTabId"], json!("tb-4e8d0c2f1"));
        assert_eq!(v["mode"], json!("ui"));
        assert_eq!(v["promptHook"], json!(true));
    }

    /// Design 011 §7 test 5 asserted `leaf == owner` for a renderer-created tab
    /// root. **Design 014 §A1 supersedes it**: every root leaf is a minted `tm-`
    /// now, so the two are never equal — and a test still demanding the equality
    /// argues for the very defect the design removed. Inverted rather than
    /// deleted, because "these two ids are DIFFERENT" is the invariant that
    /// replaced it and it deserves to be pinned.
    #[test]
    fn a_renderer_created_root_reports_a_leaf_distinct_from_its_owner() {
        let mut t = identity_sample();
        t.renderer_terminal_id = Some("tm-9f2c1a4b7".into());
        t.owning_tab_id = Some("tb-4e8d0c2f1".into());
        let v = terminal_identity_json(&t, "ui");
        assert_eq!(v["terminalId"], json!("tm-9f2c1a4b7"));
        assert_eq!(v["owningTabId"], json!("tb-4e8d0c2f1"));
        assert_ne!(v["terminalId"], v["owningTabId"]);
    }

    /// Correction C1: before P0-A `tab_id` was never None, so this shape could
    /// not occur. It can now — a headless API/fleet spawn has no renderer pane —
    /// and it must serialise as JSON null, NOT as the `pc-` process id.
    #[test]
    fn a_headless_terminal_reports_null_identities_not_a_process_id() {
        let mut t = identity_sample();
        t.renderer_terminal_id = None;
        t.owning_tab_id = None;
        let v = terminal_identity_json(&t, "ui");
        assert_eq!(v["terminalId"], json!(null));
        assert_eq!(v["tabId"], json!(null));
        assert_eq!(v["owningTabId"], json!(null));
        // The PTY is still addressable — only the renderer identities are absent.
        assert_eq!(v["id"], json!("pc-abc123def"));
    }

    /// Correction C4. `flagTabActivity` (tabsSlice.ts:133-141) resolves its
    /// argument against `state.tabs`, which holds ONLY root tab ids — a `tm-*`
    /// leaf finds nothing and the dispatch silently no-ops. The payload must
    /// therefore carry the OWNER explicitly.
    #[test]
    fn a_split_panes_activity_payload_carries_the_owning_tab() {
        let v = external_activity_payload(
            "pc-abc123def",
            Some("tm-9f2c1a4b7"),
            Some("tb-4e8d0c2f1"),
        );
        assert_eq!(v["owningTabId"], json!("tb-4e8d0c2f1"));
        assert_eq!(v["rendererTerminalId"], json!("tm-9f2c1a4b7"));
    }

    /// The two pre-existing keys must not move: `terminalId` here has always
    /// been the PROCESS id (the DashMap key passed by the caller), unlike every
    /// REST response where it is the leaf. That asymmetry is why the new
    /// explicit `processId` / `rendererTerminalId` keys exist.
    #[test]
    fn the_legacy_activity_keys_are_unchanged() {
        let v = external_activity_payload(
            "pc-abc123def",
            Some("tm-9f2c1a4b7"),
            Some("tb-4e8d0c2f1"),
        );
        assert_eq!(v["terminalId"], json!("pc-abc123def"));
        assert_eq!(v["processId"], json!("pc-abc123def"));
        assert_eq!(v["tabId"], json!("tm-9f2c1a4b7"));
    }

    #[test]
    fn an_unknown_terminal_yields_nulls_rather_than_a_missing_key() {
        let v = external_activity_payload("pc-gone", None, None);
        assert_eq!(v["rendererTerminalId"], json!(null));
        assert_eq!(v["owningTabId"], json!(null));
        assert_eq!(v["terminalId"], json!("pc-gone"));
    }

    /// Deterministic id minting so the tests assert values, not shapes.
    fn counting_mint() -> impl FnMut(&str) -> String {
        let mut n = 0u32;
        move |prefix: &str| {
            n += 1;
            format!("{prefix}-{n:09}")
        }
    }

    /// THE REGRESSION TEST (design 011 §7 test 1), as amended by option A. Two
    /// API creates targeting the same tab must produce DISTINCT leaves and the
    /// SAME owner. Before P0-A both stored `tb-shared01` as `tab_id`, which is
    /// the `terminal_history` PRIMARY KEY: one PTY got reaped by StateManager's
    /// reconcile, and closing either pane deleted the other's scrollback.
    /// Originally this test drove the collision through the split-a-pane
    /// (`paneId`) flow specifically, alongside a sibling test for the no-`paneId`
    /// (Mode 2) shape. Option A removed `pane_id` from the decision entirely —
    /// EVERY API create takes this path now, `paneId` or not — so both shapes
    /// collapse onto the same two-calls-in-a-row test.
    #[test]
    fn spawn_identity_two_api_splits_get_distinct_leaves_and_one_owner() {
        let mut mint = counting_mint();
        let a = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("split a");
        let b = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("split b");

        assert_ne!(a.renderer_terminal_id, b.renderer_terminal_id);
        assert!(a.renderer_terminal_id.starts_with("tm-"));
        assert!(b.renderer_terminal_id.starts_with("tm-"));
        assert_eq!(a.owning_tab_id, "tb-shared01");
        assert_eq!(b.owning_tab_id, "tb-shared01");
    }

    /// THE PINNED BEHAVIOUR CHANGE (option A). Design 011 §7 test 5 used to read
    /// "the leaf equals the owner for a tab's FIRST live terminal" — true right
    /// up until the *renderer* path could ALSO be that tab's first live
    /// terminal (a user restarting an exited root pane, which `commands::create_terminal`
    /// can never refuse). An API create cannot tell "genuinely new tab" from
    /// "this tab's root just died" apart from this signal alone, and guessing
    /// wrong (claiming the root) is exactly what produced the duplicate-leaf
    /// bug: two live terminals sharing one `terminal_history` PRIMARY KEY. So an
    /// API create now NEVER claims the root leaf — not even here, into a
    /// brand-new empty tab with no `paneId`, the one shape that used to be the
    /// clearest-cut "obviously it's the root". This is the exact behaviour
    /// change P0-A/option A makes and the one this test exists to pin.
    #[test]
    fn spawn_identity_first_create_into_an_empty_tab_still_gets_a_fresh_tm_leaf() {
        let mut mint = counting_mint();
        let r = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("root");
        assert!(
            r.renderer_terminal_id.starts_with("tm-"),
            "an API create must never take the tab's own id as its leaf, even \
             into a brand-new empty tab: got {}",
            r.renderer_terminal_id
        );
        assert_ne!(r.renderer_terminal_id, "tb-shared01");
        assert_eq!(r.owning_tab_id, "tb-shared01");
    }

    /// NEW (not a conversion). Pins the exact shape of the behaviour change in
    /// isolation, independent of the test above: no `paneId` at all (there is no
    /// such parameter any more), a brand-new tab with no id supplied by the
    /// caller (so it is minted here, same as any other API create), and the
    /// resulting pane still gets a `tm-` leaf with `owning_tab_id` correctly set
    /// to that freshly-minted tab. If this ever regresses to `leaf == owner`,
    /// this is the test that must fail.
    #[test]
    fn an_api_create_with_no_pane_id_into_a_brand_new_tab_gets_a_tm_leaf_not_the_tab_id() {
        let mut mint = counting_mint();
        let r = resolve_api_spawn_identity(None, None, &mut mint)
            .expect("brand-new tab, no ids supplied at all");
        assert!(
            r.renderer_terminal_id.starts_with("tm-"),
            "got {} instead of a tm- leaf",
            r.renderer_terminal_id
        );
        assert!(r.owning_tab_id.starts_with("tb-"));
        assert_eq!(
            r.owning_tab_id, "tb-000000001",
            "the owner is the freshly-minted tab, same as before option A"
        );
        assert_ne!(
            r.renderer_terminal_id, r.owning_tab_id,
            "the whole point: leaf and owner are no longer the same id"
        );
    }

    /// Design 011 §7 test 9 / D7 — the gap review 095 B1 found, which the suite
    /// previously asserted as CORRECT for the `pane_id`-absent-but-tab-occupied
    /// case only. Option A generalises the fix: it no longer depends on the tab
    /// already being occupied, or on any occupancy scan at all — a second create
    /// into the same tab (still no pane id) gets a distinct `tm-` leaf for
    /// exactly the same reason the FIRST one now does.
    #[test]
    fn spawn_identity_second_create_into_a_populated_tab_gets_a_distinct_leaf() {
        let mut mint = counting_mint();
        let root = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("first create");
        assert!(root.renderer_terminal_id.starts_with("tm-"));

        let second = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("second create");
        assert_ne!(
            second.renderer_terminal_id, root.renderer_terminal_id,
            "a renderer leaf id must be unique per live terminal"
        );
        assert!(
            second.renderer_terminal_id.starts_with("tm-"),
            "a tab's second pane is a split whatever the caller sent, got {}",
            second.renderer_terminal_id
        );
        assert_eq!(second.owning_tab_id, "tb-shared01", "and it stays in that tab");
    }

    /// THE T2-F1 REGRESSION TEST (external review 099), CONVERTED. This used to
    /// model the decision→registration window between an identity decision and
    /// `spawn_terminal`'s final `terminals` insert, and prove a claim held
    /// across it. Option A removes that window for the API path entirely:
    /// `resolve_api_spawn_identity` reads and writes no shared state at all —
    /// not `terminals`, not `RootLeafClaims` — so there is nothing to interleave
    /// and nothing left to race. What survives is the stronger property that
    /// makes the window irrelevant: however many API creates are interleaved for
    /// the same tab — sequential here, real concurrency in the test below —
    /// none of them may ever produce a `tb-` leaf.
    #[test]
    fn a_create_inside_another_creates_spawn_window_cannot_take_the_same_root_leaf() {
        let mut mint = counting_mint();

        // "A" decides its identity. Under the pre-option-A code its PTY was
        // still being built at this point, so it had NOT registered anywhere.
        let a = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("create A");
        assert!(a.renderer_terminal_id.starts_with("tm-"), "A is never the tab root");

        // "B" arrives INSIDE what used to be that window. There is no scan left
        // to go stale — B's answer never depended on A having registered.
        let b = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("create B");
        assert_ne!(
            b.renderer_terminal_id, a.renderer_terminal_id,
            "two live terminals must never carry the same renderer leaf"
        );
        assert!(b.renderer_terminal_id.starts_with("tm-"));
        assert_eq!(b.owning_tab_id, "tb-shared01", "and it still lands in that tab");

        // "C" arrives after "A" would have registered. Still just another split.
        let c = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("create C");
        assert!(
            c.renderer_terminal_id.starts_with("tm-"),
            "every API create into this tab is a split, in any order: {}",
            c.renderer_terminal_id
        );
    }

    /// CONVERTED. This used to prove a failed spawn releases its RAII root-leaf
    /// reservation, so a retry could still claim the root. Option A removes the
    /// reservation itself (`RootLeafClaims` is no longer consulted from the API
    /// path) — there is nothing to leak, because there is nothing to hold. What
    /// survives is the retry guarantee: a create that follows a failed one (real
    /// or simulated — resolution can't tell the difference, it has no side
    /// effects to undo) still independently mints its own fresh `tm-` leaf,
    /// never the tab id, and never collides with the attempt before it.
    #[test]
    fn a_failed_spawn_leaves_nothing_to_leak_and_the_retry_gets_its_own_tm_leaf() {
        let mut mint = counting_mint();

        // Stands in for an attempt whose `spawn_terminal` subsequently failed —
        // resolution itself has no state to roll back.
        let first = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("first create");
        assert!(first.renderer_terminal_id.starts_with("tm-"));

        let retry = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint)
            .expect("retry");
        assert!(
            retry.renderer_terminal_id.starts_with("tm-"),
            "the tab is still empty, but a retry still never claims its id: {}",
            retry.renderer_terminal_id
        );
        assert_ne!(retry.renderer_terminal_id, first.renderer_terminal_id);
    }

    /// CONVERTED. Used to prove exactly one of many racing creates could win the
    /// root leaf under real thread concurrency (the atomicity of
    /// `RootLeafClaims::try_claim`). Option A makes that race structurally
    /// impossible for the API path — `resolve_api_spawn_identity` touches no
    /// shared state, so there is nothing for concurrent callers to contend over
    /// — so the stronger property this now pins is design 011's headline
    /// invariant directly: no API create, under ANY ordering or concurrency,
    /// ever produces a `tb-` renderer leaf. Real threads (not just sequential
    /// calls) still earn their keep here: they exercise `mint_renderer_id`'s
    /// uuid generation under genuine concurrency, proving leaf uniqueness holds
    /// even without a coordinating claim.
    #[test]
    fn no_racing_api_create_ever_gets_the_root_leaf() {
        const RACERS: usize = 8;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(RACERS));

        let handles: Vec<_> = (0..RACERS)
            .map(|_| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    resolve_api_spawn_identity(Some("tb-shared01"), None, mint_renderer_id)
                        .expect("racing create")
                })
            })
            .collect();

        let results: Vec<_> = handles.into_iter().map(|h| h.join().expect("thread")).collect();

        assert!(
            results.iter().all(|id| id.renderer_terminal_id.starts_with("tm-")),
            "no racer may take the tab id as its leaf: {results:?}"
        );
        let leaves: std::collections::HashSet<_> =
            results.iter().map(|id| id.renderer_terminal_id.clone()).collect();
        assert_eq!(leaves.len(), RACERS, "every racer's leaf must be distinct: {leaves:?}");
        assert!(results.iter().all(|id| id.owning_tab_id == "tb-shared01"));
    }

    #[test]
    fn spawn_identity_no_caller_id_mints_a_tab_exactly_as_before() {
        let mut mint = counting_mint();
        let r = resolve_api_spawn_identity(None, None, &mut mint).expect("minted");
        assert_eq!(r.owning_tab_id, "tb-000000001");
        // Pre-option-A this asserted `r.renderer_terminal_id == r.owning_tab_id`
        // ("exactly as before" meant leaf == owner for a fresh tab). Now the
        // owner is still freshly minted exactly as before, but the leaf is not.
        assert!(r.renderer_terminal_id.starts_with("tm-"));
        assert_ne!(r.renderer_terminal_id, r.owning_tab_id);
    }

    #[test]
    fn spawn_identity_an_empty_or_unrecognised_tab_id_still_mints_rather_than_failing() {
        let mut mint = counting_mint();
        assert!(resolve_api_spawn_identity(Some("   "), None, &mut mint)
            .expect("blank")
            .owning_tab_id
            .starts_with("tb-"));
        assert!(resolve_api_spawn_identity(Some("legacy-monitor-id"), None, &mut mint)
            .expect("junk")
            .owning_tab_id
            .starts_with("tb-"));
    }

    /// Correction C3. `api_server.rs:494` recognised `tb-` ONLY: a caller that
    /// did the "right" thing and sent a genuine `tm-` id had it silently thrown
    /// away and replaced by an unrelated fresh `tb-`, so the pane landed in the
    /// WRONG tab with no diagnostic. Fail closed instead, and name the field
    /// that carries the correct value.
    #[test]
    fn spawn_identity_a_pane_leaf_id_in_the_tab_field_is_rejected_not_silently_replaced() {
        let mut mint = counting_mint();
        let err = resolve_api_spawn_identity(Some("tm-9f2c1a4b7"), None, &mut mint)
            .expect_err("a tm- id is a pane id, not a tab id");
        assert!(err.contains("tm-9f2c1a4b7"), "the message must name the offending id: {err}");
        assert!(err.contains("owningTabId"), "the message must name the right field: {err}");
    }

    /// An explicit `owningTabId` wins over `tabId` — it is the unambiguous field.
    #[test]
    fn spawn_identity_an_explicit_owning_tab_id_takes_precedence() {
        let mut mint = counting_mint();
        let r = resolve_api_spawn_identity(Some("tb-ignored1"), Some("tb-explicit"), &mut mint)
            .expect("explicit owner");
        assert_eq!(r.owning_tab_id, "tb-explicit");
        assert!(r.renderer_terminal_id.starts_with("tm-"));
    }

    fn identity_temp_db() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "termflow_identity_{}_{}.db",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    /// Design 011 §7 test 2 — history isolation, end to end at the storage
    /// layer. Two API splits in one tab must occupy two rows, and closing one
    /// (`commands.rs:1028-1030` deletes by the renderer id) must leave the
    /// other's scrollback intact. Before P0-A both ids were `tb-shared01`, so
    /// the second upsert clobbered the first and the delete wiped both.
    #[test]
    fn two_api_splits_no_longer_share_one_history_row() {
        let mut mint = counting_mint();
        // Every API create mints a fresh `tm-` unconditionally now, so distinct
        // leaves need no occupancy probe to force them.
        let a = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("split a");
        let b = resolve_api_spawn_identity(Some("tb-shared01"), None, &mut mint).expect("split b");

        let store = crate::history_store::HistoryStore::new();
        store.init(&identity_temp_db());
        store.upsert(&a.renderer_terminal_id, &["pane A scrollback".to_string()], 1);
        store.upsert(&b.renderer_terminal_id, &["pane B scrollback".to_string()], 2);

        assert_eq!(
            store.get(&a.renderer_terminal_id),
            Some(vec!["pane A scrollback".to_string()]),
            "pane A's history must not be overwritten by pane B's flush"
        );

        // Closing pane A.
        store.delete(&a.renderer_terminal_id);
        assert_eq!(store.get(&a.renderer_terminal_id), None);
        assert_eq!(
            store.get(&b.renderer_terminal_id),
            Some(vec!["pane B scrollback".to_string()]),
            "closing one split must not delete the other's scrollback"
        );
    }


    // The `/health` contract the startup smoke test (scripts/smoke-test-release.mjs)
    // depends on: it polls this endpoint and treats `status: "ok"` as "the build
    // launched". Pin that body here so a rename (e.g. status → "healthy") can't
    // silently make the smoke gate un-satisfiable. The router wiring + real HTTP
    // binding are covered end-to-end by the smoke script against the built binary;
    // this guards the payload the handler serialises.
    #[test]
    fn health_body_reports_ok_status_and_instance_id() {
        let body = health_body("inst-abc123");
        assert_eq!(body["status"], "ok", "smoke test keys off status == ok");
        assert_eq!(body["app"], "auto-terminal");
        assert_eq!(
            body["instanceId"], "inst-abc123",
            "health must echo this process's instanceId for P0b conflict detection"
        );
    }

    #[test]
    fn test_render_terminal_history_replays_cursor_movement() {
        let mut history = std::collections::VecDeque::new();
        history.push_back("aaaaa\r\nbbbbb\r\nccccc".to_string());
        history.push_back("\x1b[H11111\r\n22222\r\n33333".to_string());

        let rendered = render_terminal_history(&history, 24, 80);

        assert_eq!(rendered.trim_end(), "11111\n22222\n33333");
    }

    #[test]
    fn test_render_terminal_history_overwrites_same_line() {
        let mut history = std::collections::VecDeque::new();
        history.push_back("loading".to_string());
        history.push_back("\rbooting".to_string());

        let rendered = render_terminal_history(&history, 24, 80);

        assert_eq!(rendered.trim_end(), "booting");
    }

    // The hydration snapshot relies on contents_formatted() round-tripping: a
    // freshly-reset terminal that consumes the snapshot must reproduce the exact
    // visible screen (including styles), so a reconnecting client stays in sync.
    #[test]
    fn test_formatted_snapshot_round_trips_screen() {
        let mut source = vt100::Parser::new(24, 80, 0);
        // Colored text plus cursor positioning, like a TUI redraw.
        source.process(b"\x1b[31mred\x1b[0m\r\nplain\r\n\x1b[5;10Hmoved");

        let snapshot = source.screen().contents_formatted();

        // Replay the snapshot into a fresh parser of the same size.
        let mut restored = vt100::Parser::new(24, 80, 0);
        restored.process(&snapshot);

        assert_eq!(
            restored.screen().contents(),
            source.screen().contents(),
            "snapshot replay must reproduce the source screen text"
        );
        // Styles (SGR colors/attrs) must round-trip too, not just plain text:
        // contents_formatted of the restored screen must equal the source's.
        assert_eq!(
            restored.screen().contents_formatted(),
            source.screen().contents_formatted(),
            "snapshot replay must reproduce styling, not just text"
        );
        // Cursor position must be preserved so incremental TUI redraws align.
        assert_eq!(
            restored.screen().cursor_position(),
            source.screen().cursor_position(),
            "snapshot replay must restore the cursor position"
        );
    }

    // Pins WHY the reader-facing screen (`/fleet/screen`, fleet execute) renders from
    // the grid via `contents()` instead of regex-stripping escapes out of
    // `contents_formatted()`: the formatted blob encodes runs of blanks as cursor ops,
    // so stripping silently collapses column alignment.
    #[test]
    fn plain_screen_text_keeps_alignment_that_escape_stripping_destroys() {
        let mut p = vt100::Parser::new(24, 80, 0);
        // Two columns, the second placed by absolute cursor positioning — the shape a
        // full-screen TUI (status bar, sidebar) produces.
        p.process(b"\x1b[1;1HNAME\x1b[1;40HSTATUS\r\n\x1b[2;1Hbuild\x1b[2;40Hok");

        let text = p.screen().contents();
        let first = text.lines().next().expect("a first row");
        // The gap survives as real spaces, so the columns still line up.
        assert!(first.starts_with("NAME"), "got {first:?}");
        assert_eq!(first.find("STATUS"), Some(39), "STATUS must stay in column 40");

        // Whereas the formatted blob carries no such spaces to preserve: it moves the
        // cursor instead, so dropping escapes would butt the columns together.
        let formatted = String::from_utf8_lossy(&p.screen().contents_formatted()).into_owned();
        assert!(
            !formatted.contains("NAME                                   STATUS"),
            "formatted blob is expected to encode the gap as cursor motion, not spaces"
        );
    }

    /// The body `GET /api/terminals/:id/screen` actually serves, on the fixture that makes the
    /// difference visible: two columns placed by absolute cursor positioning - the shape a status
    /// bar or a sidebar produces.
    ///
    /// `plain_screen_text_keeps_alignment_that_escape_stripping_destroys` above pins the property
    /// of the vt100 primitive; this pins that THIS ROUTE'S PAYLOAD carries it, under the exact
    /// wire keys the rule editor's preview card reads. The second half spells out the alternative
    /// the route replaces - fetch `/snapshot`, strip the escapes in the client - and watches it
    /// lose the gap outright, so the two are visibly not interchangeable rather than merely
    /// asserted to be.
    #[test]
    fn the_screen_route_body_keeps_columns_the_snapshot_blob_encodes_as_cursor_ops() {
        let mut p = vt100::Parser::new(24, 80, 0);
        p.process(b"\x1b[1;1HNAME\x1b[1;40HSTATUS\r\n\x1b[2;1Hbuild\x1b[2;40Hok");

        // Exactly what the handler passes in: `AppState::screen_text`'s render of the grid.
        let body = screen_body("tm-9f2c1a4b7", &p.screen().contents(), 24, 80);

        // The wire contract, by exact key name.
        assert_eq!(
            body["terminalId"],
            json!("tm-9f2c1a4b7"),
            "the caller's own reference is echoed back, not the resolved pc- map key"
        );
        assert_eq!(body["rows"], json!(24));
        assert_eq!(body["cols"], json!(80));

        let screen = body["screen"].as_str().expect("`screen` must serialise as a string");
        let first = screen.lines().next().expect("a first row");
        assert!(first.starts_with("NAME"), "got {first:?}");
        assert_eq!(first.find("STATUS"), Some(39), "STATUS must stay in column 40");
        let second = screen.lines().nth(1).expect("a second row");
        assert_eq!(
            second.find("ok"),
            Some(39),
            "the second row must line up under the first, not just survive on its own"
        );

        // The alternative: take `/snapshot`'s replay blob and strip its escapes, as the rule
        // editor's preview card was doing. The blob encodes the gap as cursor motion, so there
        // are no spaces left to hold the columns apart and the two headings butt together.
        let blob = String::from_utf8_lossy(&p.screen().contents_formatted()).into_owned();
        let stripped = regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]")
            .expect("a valid CSI pattern")
            .replace_all(&blob, "")
            .into_owned();
        assert!(
            stripped.contains("NAMESTATUS"),
            "escape-stripping the replay blob is expected to collapse the gap, got {stripped:?}"
        );
    }

    /// The body of `async fn get_terminal_screen`, from its signature to the first closing brace
    /// in column 0 - every free function in this file ends that way.
    ///
    /// The source is cut at the first `#[cfg(test)]` so the needle finds the HANDLER and not this
    /// module's own mention of it, and read through `strip_comments` because the prose directly
    /// above the handler explains the very distinction the needles look for: `contains` cannot
    /// tell a comment from code, so an unstripped scan would pass on the explanation alone.
    fn get_terminal_screen_body() -> String {
        let source =
            crate::automation_engine::test_host::strip_comments(include_str!("mod.rs"));
        let code = &source[..source.find("#[cfg(test)]").expect("the tests must follow the code")];
        let start = code.find("async fn get_terminal_screen(").expect(
            "`get_terminal_screen` not found - this guard must fail loudly, not pass vacuously",
        );
        let rest = &code[start..];
        let end = rest.find("\n}\n").expect("the handler must close at column 0");
        rest[..end].to_string()
    }

    /// `GET /api/terminals/:id/screen` must read the GRID (`screen_text`), never the replay blob
    /// (`screen_snapshot`) - the alignment the test above pins is the whole point of the route,
    /// and sourcing it from the formatted blob would hand back cursor-op noise that no client can
    /// straighten out again.
    ///
    /// Source-derived because nothing in this process can call the handler: it takes
    /// `AppState<Wry>`, `tauri::test::mock_app` yields `AppState<MockRuntime>`, and the
    /// `integration-tests` feature that would bridge the gap breaks the Windows test binary at
    /// loader time (see `test_send_prompt_does_not_block_concurrent_removal`). So the wiring is
    /// asserted from the source text instead - which is what kills the "point it at
    /// `screen_snapshot`" mutant that a payload test, handed its text already rendered, cannot
    /// see.
    ///
    /// **The third assertion is what ties the payload test to the handler at all.** The test above
    /// calls `screen_body` DIRECTLY, so it pins that helper's key names and nothing about who uses
    /// them: replace this handler's tail with an inline `json!({ "text": ... })` and every screen
    /// test in this file still passes, `screen_body` quietly becoming dead code. The renderer would
    /// then find no `screen` key, and `AuTerminalHoverCard`'s `typeof body?.screen === 'string'`
    /// guard turns that into an empty string - a hover card stuck on "Reading its screen..." for
    /// ever, at the poll cadence, with nothing anywhere reporting a failure. Requiring the handler
    /// to go THROUGH `screen_body` is what makes the payload test speak for the wire.
    #[test]
    fn the_screen_route_reads_the_grid_not_the_replay_blob() {
        let body = get_terminal_screen_body();
        assert!(
            body.contains("state.screen_text("),
            "the handler must render from the parser's grid via screen_text, body was:\n{body}"
        );
        assert!(
            !body.contains("screen_snapshot"),
            "the handler must NOT serve the escape-sequence replay blob, body was:\n{body}"
        );
        assert!(
            body.contains("screen_body("),
            "the handler must serve the pinned wire contract rather than an inline body, \
             or the payload test above pins a helper nothing calls, body was:\n{body}"
        );
    }


    // set_size updates the grid dimensions so the snapshot has the right number
    // of rows/cols for the client viewport. Like a real VT it does NOT rewrap:
    // growing preserves content; shrinking clips beyond the new width (the running
    // program is expected to redraw on SIGWINCH). This test pins both facts.
    #[test]
    fn test_screen_set_size_updates_dimensions_and_clips() {
        // Growing preserves existing content and reports the new size.
        let mut grow = vt100::Parser::new(24, 80, 0);
        grow.process(b"hello world");
        grow.screen_mut().set_size(30, 100);
        assert_eq!(grow.screen().size(), (30, 100));
        assert!(grow.screen().contents().contains("hello world"));

        // Shrinking narrower than the content clips (does not reflow) — documenting
        // the real vt100 behavior the snapshot relies on.
        let mut shrink = vt100::Parser::new(24, 80, 0);
        let text = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWX"; // 59 chars
        shrink.process(text.as_bytes());
        shrink.screen_mut().set_size(24, 40);
        assert_eq!(shrink.screen().size(), (24, 40));
        let row0 = shrink.screen().contents();
        assert!(row0.starts_with(&text[..40]), "first 40 cols preserved");
        assert!(!row0.contains(text), "content beyond width is clipped, not reflowed");
    }


