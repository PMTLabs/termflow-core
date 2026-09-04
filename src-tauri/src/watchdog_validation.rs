//! The Rust mirror of the editor's `watchdogValidation` — for the Watchdogs rules feature, not
//! `spawn_pipeline_watchdog`.
//!
//! Two implementations of one rule set, sharing ONE case fixture so they cannot diverge silently. The
//! backend owns "is this rule allowed to run" and must not be talked into enabling an invalid rule by
//! a stale renderer: `set_watchdog_enabled` and any save with `enabled = true` re-check and refuse.
//! The boundary audit found the enable path bypassed entirely — the editor gated its own toggle, the
//! store validated nothing semantic, and the engine refused only an uncompilable pattern, so a rule
//! with no terminals and an empty message went live straight from the list row. Plan §7.8, R10.
//!
//! A `Problem` carries `severity`: only `blocks` gates the toggle. `warns` exists for the case a rule
//! whose own message text matches its own pattern (the echo failure of §2.6) and for a pattern with
//! more than one capture group (§2.2b) — unusual, not invalid, and losing work to a validation rule is
//! its own bug. **Save is never gated.**
//!
//! **M3 lands the enable path; M5 lands the shared fixture.** M0 claims the name.
