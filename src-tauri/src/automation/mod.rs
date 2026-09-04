//! Supporting modules for Terminal Automations (plan `028`).
//!
//! **One `automation*` prefix for the whole feature.** The split naming an earlier draft used
//! (`workflow_*` for the engine, `watchdog*` for the store) is exactly what produced the event-name
//! break the boundary audit found: three areas emitted or listened for three different spellings of
//! the same three events, with **zero overlap between any emitter and the only listener**, and every
//! area's own tests passed. Plan §7.1, §7.2.
//!
//! The feature was called *Watchdogs* through plan 028 and its three review rounds, and was renamed
//! before M1 — `spawn_pipeline_watchdog` in `lib.rs` is the output-pipeline stall detector, is
//! unrelated to this, and keeps that name. Docs written before the rename may still say watchdog.

pub mod events;
pub mod labels;
pub mod proc_snapshot;
pub mod roster;
pub mod runtime;
pub mod send;
pub mod targeting;
