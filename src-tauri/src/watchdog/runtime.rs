//! The Watchdogs engine's per-terminal and per-rule state — the user-facing rules engine, not
//! `spawn_pipeline_watchdog`.
//!
//! **A standalone struct rather than fields on `AppState`, and that is a testability decision, not a
//! tidiness one.** `AppState::new` takes an `AppHandle`, so anything reachable only through it can be
//! unit-tested only behind `--features integration-tests`, which `Cargo.toml` says breaks the test
//! binary at loader time on Windows. `identity_index.rs` states the same rule in its own module doc:
//! it "lives in its own file rather than on `AppState` so it can be unit-tested without a Tauri
//! `AppHandle`". Round 1's review found nine planned tests that would have compiled only on Linux
//! while two milestone gates named them — gates that could not go red. Plan §7.10.
//!
//! Holds: `arm`, `echoes`, `send_locks`, `last_eval_ms`, `dirty`, `watched`. Keyed by the durable `tm-`
//! leaf, except `dirty`, which is keyed by the `pc-` process id because that is what
//! `ChannelPayload.id` carries. Plan §7.4's table is the authority.
//!
//! Deliberately no per-pair "what did I see last time" state: an earlier design reconstructed a
//! since-last-check delta from hashed line anchors, and it broke on the most ordinary thing a terminal
//! does — the bottom line is the prompt, typing rewrites it, the anchor vanishes, and the fallback
//! re-read the whole 200-line window on every keystroke. §2.2c replaced it with a second window depth.
//!
//! **M2 fills this in.** M0 claims the name.
