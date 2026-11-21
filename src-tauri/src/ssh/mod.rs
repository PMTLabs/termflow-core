//! Rust-owned saved SSH connection definitions (IPC-only).
pub mod store;
pub mod target;
pub(crate) mod store_adapter;
#[cfg(test)]
mod t10_tests;
pub mod auth;
#[cfg(test)]
mod auth_tests;
#[cfg(test)]
mod credential_tests;
pub mod known_hosts;
pub mod launch_argv;
pub(crate) mod preview;
#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle;
#[cfg(test)]
mod prompt_tests;
pub mod session;
pub(crate) mod launch;
pub(crate) mod launch_process;
pub mod sessions;
pub mod sftp;
#[cfg(test)]
mod sftp_test_server;
#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
mod trust_engine_tests;
