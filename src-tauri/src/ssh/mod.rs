//! Rust-owned saved SSH connection definitions (IPC-only).
pub mod store;
pub mod target;
pub mod auth;
#[cfg(test)]
mod auth_tests;
#[cfg(test)]
mod credential_tests;
pub mod known_hosts;
#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle;
#[cfg(test)]
mod prompt_tests;
pub mod session;
pub mod sessions;
#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
mod trust_engine_tests;
