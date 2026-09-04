//! Supporting modules for Terminal Watchdog Workflows (plan `028`).
//!
//! One `watchdog*` prefix for the whole feature, deliberately — including the collision with
//! `spawn_pipeline_watchdog` in `lib.rs`, which watches the output PIPELINE and has nothing to do with
//! this. The split naming this replaces (`workflow_*` for the engine, `watchdog*` for the store) is
//! exactly what produced the event-name break the boundary audit found: three areas emitted or
//! listened for three different spellings of the same three events, with **zero overlap between any
//! emitter and the only listener**, and every area's own tests passed. Plan §7.1, §7.2.
//!
//! Every module here carries a doc line saying which watchdog it is.

pub mod events;
pub mod labels;
pub mod proc_snapshot;
pub mod roster;
pub mod runtime;
pub mod send;
pub mod targeting;
