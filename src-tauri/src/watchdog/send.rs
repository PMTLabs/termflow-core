//! Delivering a Watchdogs rule's message into a terminal — not `spawn_pipeline_watchdog`.
//!
//! Two things live here, and they are separated for one reason: **the engine must be unit-testable
//! without a Tauri `AppHandle`** (plan §7.10).
//!
//! - **`TerminalWriter`** — the port. `fn write(&self, pc: &str, bytes: &[u8]) -> Result<()>`. Its
//!   `AppState` implementation encapsulates the "local writer or `host_write`" choice, which appears
//!   four separate times inside `send_prompt_to_terminal` today. Tests use a recording fake, which
//!   §10.17 already assumed existed when it asserted "the fake terminal's write log is empty".
//! - **`deliver(writer, cli_type, message, submit)`** — the sequence: bracketed paste, the
//!   load-bearing 500 ms gap, focus-in, then the submit pattern from `get_cli_pattern`.
//!
//! **`deliver` is lifted OUT of `api_server::send_prompt_to_terminal`, which then calls it** — one
//! implementation, two callers. Neither re-implementing the sequence in the engine nor calling
//! `send_prompt_to_terminal` from it is acceptable: the first is `two-implementations-one-fix` on a
//! sequence whose 500 ms gap carries a verified comment about Codex absorbing a CR that arrives in the
//! same read chunk, and the second takes `&AppState<R>` and would drag the whole send path behind an
//! `AppHandle`.
//!
//! `submit` is `false` for the mockup's *Answer a confirmation* template, which types `1` and must NOT
//! press Enter. A send path that always submits breaks that one template while every other passes.
//!
//! The send checks the engine's `stopping` flag **before its first write, never between the paste and
//! the submit**, so a quit either leaves the send unstarted or lets it finish. Plan §2.1, §2.5.
//!
//! **M0.4 lands the extraction; M3 lands the engine's caller.** M0 claims the name.
