use crate::commands;
use crate::window_restore::show_or_focus_main_window;
use tauri::Emitter;

/// Build the system tray icon + menu (Plan 010). Reuses the app's default window
/// icon (no new asset). Left-click shows/focuses the main window; the context menu
/// offers Show TermFlow / Peers… / Restart, keep terminals / Quit. Tray failure is
/// non-fatal (the app runs without a tray), so background mode simply has no tray
/// affordance in that case.
pub(crate) fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "tray_show", "Show TermFlow", true, None::<&str>)?;
    let peers = MenuItem::with_id(app, "tray_peers", "Peers…", true, None::<&str>)?;
    let restart =
        MenuItem::with_id(app, "tray_restart", "Restart, keep terminals", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &peers, &restart, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        // Left-click is handled by on_tray_icon_event (show window); the menu opens
        // on right-click only, so a left-click doesn't pop the menu instead.
        .show_menu_on_left_click(false)
        // Marked per profile: several instances mean several tray icons.
        .tooltip(crate::profile::decorate_title("TermFlow"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_or_focus_main_window(app),
            "tray_peers" => {
                show_or_focus_main_window(app);
                // Best-effort: ask the renderer to jump to Settings → Peers. If no
                // window is listening yet the user still lands on a visible window.
                let _ = app.emit("tray:open-peers", ());
            }
            // Plan 044: same restart path a webview-death recovery uses, run on
            // demand for a crash loop the auto-recovery gave up on, or just an
            // impatient user. Renderer is presumed healthy here, so it gets the
            // normal flush (cwd snapshot included) before the relaunch.
            // Whoever WINS `restart_in_flight` owns the run, and so owns telling
            // the user if it fails — the losing caller (possibly the automatic
            // recovery for the same death) got `RESTART_IN_FLIGHT` and stays
            // silent on the strength of this one speaking up.
            "tray_restart" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    match commands::restart_keeping_terminals(
                        app.clone(),
                        commands::FlushPolicy::Renderer,
                    )
                    .await
                    {
                        Ok(()) => {}
                        Err(e) if e == commands::RESTART_IN_FLIGHT => {
                            log::info!("[RECOVERY] tray restart: {e}");
                        }
                        Err(e) => crate::webview_recovery::report_restart_failure(
                            &app,
                            crate::webview_recovery::TOAST_RESTART_FAILED,
                            &e,
                        ),
                    }
                });
            }
            // Give every window a chance to persist first (plan 018 Task 8):
            // a bare exit(0) fires no CloseRequested, so no renderer would save.
            "tray_quit" => commands::flush_then_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_or_focus_main_window(tray.app_handle());
            }
        });

    // Reuse the bundled window icon so no new asset is required.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// Source-wiring tests (the same technique as `commands/update.rs` and
/// `commands/window.rs`): `TrayIconBuilder`/`Menu` need a live `AppHandle`,
/// which a unit-test process cannot construct on Windows.
#[cfg(test)]
mod tray_wiring_tests {
    fn source() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("tray.rs");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display()))
            .replace("\r\n", "\n")
    }

    /// Restart sits directly ABOVE Quit (plan 044 T5): between Peers… and Quit.
    ///
    /// Parses the actual `Menu::with_items(app, &[...])` slice literal for its
    /// identifier order — checking only that the `"tray_*"` id STRINGS occur
    /// somewhere in the file in the right order (as the declaration order of
    /// `MenuItem::with_id` calls, unrelated to what is actually passed to
    /// `Menu::with_items`) would pass even with the slice argument order itself
    /// swapped. Also confirms each identifier is bound to its matching id
    /// string, so a swapped BINDING (`let restart = ...with_id(app, "tray_peers"...)`)
    /// cannot hide behind a correctly-ordered slice.
    #[test]
    fn menu_items_are_built_in_the_documented_order() {
        let src = source();

        let call_at = src
            .find("Menu::with_items(app, &[")
            .expect("Menu::with_items(app, &[...]) call not found");
        let open = src[call_at..]
            .find('[')
            .map(|i| call_at + i)
            .expect("no `[` after Menu::with_items(app, &");
        let close = src[open..]
            .find(']')
            .map(|i| open + i)
            .expect("no closing `]` for the Menu::with_items slice");
        let slice_text = &src[open + 1..close];
        let idents: Vec<&str> = slice_text
            .split(',')
            .map(|s| s.trim().trim_start_matches('&'))
            .filter(|s| !s.is_empty())
            .collect();
        assert_eq!(
            idents,
            vec!["show", "peers", "restart", "quit"],
            "Menu::with_items must be given show, peers, restart, quit in that order: {slice_text}"
        );

        for (ident, id) in [
            ("show", "tray_show"),
            ("peers", "tray_peers"),
            ("restart", "tray_restart"),
            ("quit", "tray_quit"),
        ] {
            let let_at = src
                .find(&format!("let {ident} ="))
                .unwrap_or_else(|| panic!("`let {ident} =` not found in tray.rs"));
            // `MenuItem::with_id(app, "..."` can sit on the next line after
            // `let restart =`, so scan a short window rather than requiring
            // an exact adjacent substring.
            let window = &src[let_at..(let_at + 200).min(src.len())];
            let call_at = window
                .find("MenuItem::with_id(app, \"")
                .unwrap_or_else(|| {
                    panic!("no MenuItem::with_id(app, \"...\") near `let {ident} =`. Window:\n{window}")
                });
            let id_start = call_at + "MenuItem::with_id(app, \"".len();
            let rest = &window[id_start..];
            let id_end = rest.find('"').expect("unterminated id string literal");
            let got_id = &rest[..id_end];
            assert_eq!(
                got_id, id,
                "`{ident}` must be bound to \"{id}\", got \"{got_id}\""
            );
        }
    }

    /// The body of the `"tray_restart"` match arm, found by counting braces from
    /// its first `{`.
    fn tray_restart_arm(src: &str) -> String {
        let start = src
            .find("\"tray_restart\" =>")
            .expect("`tray_restart` arm not found");
        let rest = &src[start..];
        let open = rest.find('{').expect("tray_restart arm has no block body");
        let mut depth = 0usize;
        for (i, c) in rest[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return rest[open..open + i + 1].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces in tray_restart arm");
    }

    /// The tray restart must route to the plan 044 shared path — never to a
    /// real quit (`disarm_then_exit` / `flush_then_exit`), which would defeat
    /// the whole point of a restart that keeps terminals alive — and, as the
    /// renderer is presumed healthy here, with the `Renderer` flush policy
    /// (AC4: cwd snapshot persisted before the relaunch).
    #[test]
    fn tray_restart_routes_to_restart_keeping_terminals_never_to_quit() {
        let src = source();
        let arm = tray_restart_arm(&src);
        let call = arm
            .find("restart_keeping_terminals(")
            .expect("tray_restart must call restart_keeping_terminals");
        let args = &arm[call..arm[call..].find(".await").map(|i| call + i).unwrap_or(arm.len())];
        assert!(
            args.contains("FlushPolicy::Renderer") && !args.contains("FlushPolicy::Skip"),
            "the tray path presumes a live renderer and must flush it. Call:\n{args}"
        );
        assert!(
            !arm.contains("disarm_then_exit") && !arm.contains("flush_then_exit"),
            "tray_restart must never route through a real-quit path. Arm:\n{arm}"
        );
    }

    /// The tray run reports its OWN failure (log + toast) — but not a busy
    /// refusal, which means another run owns the restart and will report.
    #[test]
    fn tray_restart_reports_a_failure_but_not_a_busy_refusal() {
        let src = source();
        let arm = tray_restart_arm(&src);
        let busy_at = arm
            .find("RESTART_IN_FLIGHT")
            .expect("tray_restart must recognise RESTART_IN_FLIGHT");
        let report_at = arm
            .find("report_restart_failure(")
            .expect("tray_restart must report a real failure via report_restart_failure");
        assert!(busy_at < report_at, "the busy arm must be matched before the failure arm. Arm:\n{arm}");
        let busy_arm = &arm[busy_at..report_at];
        assert!(
            !busy_arm.contains("report_restart_failure") && !busy_arm.contains("show_info_toast"),
            "a busy refusal must stay silent. Arm:\n{busy_arm}"
        );
        assert!(
            arm[report_at..].contains("TOAST_RESTART_FAILED"),
            "the tray failure uses the restart wording, not the automatic-restore one"
        );
    }
}
