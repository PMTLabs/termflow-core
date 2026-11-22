//! Shared helper code requirements for staging and live-process verification.
pub(crate) const HELPER_IDENTIFIER: &str = "app.termflow.desktop.pty-host";
pub(crate) const DEBUG_REQUIREMENT: &str = "identifier \"app.termflow.desktop.pty-host\"";
pub(crate) const RELEASE_REQUIREMENT: &str = "identifier \"app.termflow.desktop.pty-host\" and anchor apple generic and certificate leaf[subject.OU] = \"68M75D67LJ\"";

pub(crate) fn helper_requirement() -> &'static str {
    if cfg!(debug_assertions) { DEBUG_REQUIREMENT } else { RELEASE_REQUIREMENT }
}
