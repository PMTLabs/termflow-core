//! Embed the TermFlow app icon (and basic version info) into the sidecar
//! executable on Windows so it shows a proper icon in Explorer / Task Manager
//! instead of the generic exe glyph. No-op on macOS/Linux.
fn main() {
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        // Icon lives in the sibling Tauri icons dir (src-tauri/icons/icon.ico).
        res.set_icon("../icons/icon.ico");
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
