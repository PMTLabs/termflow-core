//! One shared process snapshot for the Automations feature.
//!
//! A `System` behind a mutex with `taken_at` and a 2 s TTL, built inside `spawn_blocking` because
//! `System::new_all()` is 50-200 ms of blocking work and `list_watchable_terminals` is an `async`
//! command. Taken only when at least one enabled rule needs it, mirroring `AgentSchemeTracker.tick()`.
//!
//! It exists because the alternative was three full process enumerations every ~2 s: this feature's
//! own tick plus one `AgentSchemeTracker` per open window. `get_active_processes` is threaded through
//! it too, so the tracker's poll, the targeting tick and the picker all draw from one snapshot per TTL
//! window. Plan §4.4.
//!
//! **M2 fills this in.** M0 claims the name.
