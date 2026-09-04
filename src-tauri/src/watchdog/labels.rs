//! `label_at` — the ONE terminal-name resolver for the Watchdogs feature. Not
//! `spawn_pipeline_watchdog`.
//!
//! One implementation, because the boundary audit found two and **the wrong one sat on the write
//! path**: the engine's read `state.terminals[pc].name`, which is `Terminal-{shell}` for every
//! renderer-created terminal, so the log's Name column would have shown a guess for every unrenamed
//! terminal — precisely what R17 forbids — while the correct resolver sat dead behind a passing test.
//!
//! Resolution order (plan §4.5):
//!   1. the live terminal's `display_label`;
//!   2. its `name`, ONLY when that is not the derived placeholder — this preserves an agent- or
//!      fleet-supplied name while refusing `Terminal-powershell`, a shell label dressed as a name;
//!   3. the rule's own last-known label snapshot for that `tm-`;
//!   4. `None`, stored as NULL and rendered as an empty column. **Never invented.**
//!
//! Called at DECIDE time and carried in the pending-send record, never at write time: the
//! `failed - the terminal closed` entry is written after the terminal is gone.
//!
//! **M2 fills this in.** M0 claims the name.
