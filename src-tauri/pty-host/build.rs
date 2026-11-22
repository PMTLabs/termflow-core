//! Embed the TermFlow app icon (and basic version info) into the sidecar
//! executable on Windows so it shows a proper icon in Explorer / Task Manager
//! instead of the generic exe glyph. No-op on macOS/Linux.
fn main() {
    #[cfg(windows)]
    {
        // `TERMFLOW_ICON_PROFILE` is set by the package.json script that invoked
        // this build (dev/rel-al/nightly), so the sidecar carries the same
        // per-profile colour as the main app. Unset (default `rel`) build/dev
        // scripts keep the original icon.
        let icon = match std::env::var("TERMFLOW_ICON_PROFILE").ok().as_deref() {
            Some("rel-al") => "../icons/rel-al/icon.ico",
            Some("dev") => "../icons/dev/icon.ico",
            Some("nightly") => "../icons/nightly/icon.ico",
            _ => "../icons/icon.ico",
        };
        let mut res = winresource::WindowsResource::new();
        res.set_icon(icon);
        res.set("FileDescription", "TermFlow PTY Host");
        res.set("ProductName", "TermFlow");
        res.set("CompanyName", "TermFlow");
        if let Err(e) = res.compile() {
            // Don't fail the build if the resource compiler is unavailable;
            // the binary just falls back to the default icon.
            println!("cargo:warning=winresource icon embed failed: {e}");
        }
    }
}
