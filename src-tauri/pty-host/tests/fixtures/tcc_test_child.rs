// Separate test-only binary, using precisely the host's one-shot entry point.
#[path = "../../src/tcc_child.rs"]
mod tcc_child;
use termflow_macos_tcc::{PermissionKind, PermissionState, Tcc};
struct Fake;
impl Tcc for Fake {
    fn status(&self) -> (PermissionState, PermissionState) {
        (PermissionState::Granted, PermissionState::NotGranted)
    }
    fn request(&self, _: PermissionKind) -> PermissionState {
        PermissionState::Granted
    }
}
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match tcc_child::entry(&args, &Fake, &mut std::io::stdout()) {
        Ok(true) => {}
        _ => std::process::exit(2),
    }
}
