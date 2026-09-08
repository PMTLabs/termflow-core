use tauri::Runtime;
use super::types::*;

impl<R: Runtime> AppState<R> {
    /// The window label API/MCP terminal events should target, normalized against
    /// currently-live windows so we never route to (or show as active) a dead label.
    pub fn resolve_active_window_label(&self) -> String {
        self.resolve_active_window_label_excluding("")
    }

    /// Like `resolve_active_window_label`, but treats `exclude` as already gone (used
    /// from the window-destroyed handler, where the closing window may still appear in
    /// `webview_windows()`). Order: current choice → boot window → first real window.
    pub fn resolve_active_window_label_excluding(&self, exclude: &str) -> String {
        let chosen = self.active_window.read().clone();
        self.resolve_window_label_excluding(&chosen, exclude)
    }

    /// The window Settings should open/activate in — see `main_window`'s doc comment.
    pub fn resolve_main_window_label(&self) -> String {
        self.resolve_main_window_label_excluding("")
    }

    /// Like `resolve_main_window_label`, but treats `exclude` as already gone (used
    /// from the window-destroyed handler).
    pub fn resolve_main_window_label_excluding(&self, exclude: &str) -> String {
        let chosen = self.main_window.read().clone();
        self.resolve_window_label_excluding(&chosen, exclude)
    }

    /// Shared normalizer behind both `resolve_active_window_label_excluding` and
    /// `resolve_main_window_label_excluding`: fetches the currently-live window
    /// labels from the real `AppHandle` and hands off to `pick_window_label`, the
    /// pure selection algorithm (kept separate so it's unit-testable without a
    /// live/mock `AppHandle` — see that function's doc comment).
    fn resolve_window_label_excluding(&self, chosen: &str, exclude: &str) -> String {
        use tauri::Manager;
        let windows = self.app_handle.webview_windows();
        let live_labels: Vec<&str> = windows.keys().map(|k| k.as_str()).collect();
        pick_window_label(chosen, exclude, &live_labels)
    }
}

#[cfg(test)]
mod active_window_tests {
    use super::pick_window_label;

    #[test]
    fn default_active_window_is_main() {
        assert_eq!(super::DEFAULT_ACTIVE_WINDOW, "main");
    }

    #[test]
    fn prefers_the_chosen_label_when_it_is_still_live() {
        let live = ["main", "window-2"];
        assert_eq!(pick_window_label("window-2", "", &live), "window-2");
    }

    #[test]
    fn falls_back_to_the_boot_window_when_chosen_is_excluded() {
        // The window mid-close is passed as `exclude` because it can still appear
        // in the live set when this runs from its own destroy handler.
        let live = ["main", "window-2"];
        assert_eq!(pick_window_label("window-2", "window-2", &live), "main");
    }

    #[test]
    fn promotes_the_first_other_live_window_when_the_boot_window_is_also_gone() {
        // The exact edge case reported by the user: open a second window, close
        // the first (the boot window) — the survivor becomes the new choice.
        let live = ["window-2"];
        assert_eq!(pick_window_label("main", "main", &live), "window-2");
    }

    #[test]
    fn drag_preview_is_never_a_candidate() {
        let live = ["drag-preview"];
        assert_eq!(pick_window_label("main", "main", &live), "main");
    }

    #[test]
    fn defaults_to_the_boot_window_label_when_nothing_is_live() {
        let live: [&str; 0] = [];
        assert_eq!(pick_window_label("window-2", "window-2", &live), "main");
    }

    #[test]
    fn a_chosen_label_that_matches_exclude_falls_through_even_when_the_map_still_lists_it() {
        // Mirrors the real destroy-handler race this function exists for: the
        // closing window can still be present in `webview_windows()` when this
        // runs, so `exclude` — not map membership — must be what disqualifies it.
        let live = ["main", "window-2"];
        assert_eq!(pick_window_label("main", "main", &live), "window-2");
    }
}
