//! Persistence for Terminal Automations — rules, their pinned terminals, and the activity log.
//!
//! Plan `028`.
//!
//! Modelled line for line on `canvas_store.rs`: its **own** `rusqlite::Connection` to the same
//! per-profile `history.db`, its own `CREATE TABLE IF NOT EXISTS`, degrade-to-inert on open failure,
//! and `Result` on every method. Its own connection matters — automation writes then contend with
//! automation writes, not with the 30 s scrollback flush that holds `HistoryStore`'s mutex while it
//! writes multi-MB blobs.
//!
//! It deliberately holds **no `AppHandle`**. `append` decides whether a `automation:activity` event is
//! due and says so in its return value; the caller — the engine or the command layer, both of which
//! already have a handle — performs the emit. An `AppHandle<R>` field here would make the whole struct
//! generic over the Tauri runtime and drag its unit tests behind `--features integration-tests`, which
//! is Linux-only (`Cargo.toml`). Plan §7.5, §7.10.
//!
//! **M0 landed the types below; M1 landed the store.**

mod model;
mod sql;

pub use model::*;
pub use sql::*;
