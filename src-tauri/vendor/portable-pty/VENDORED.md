# Vendored: portable-pty 0.8.1

Upstream: <https://github.com/wez/wezterm> (`pty/`), crates.io `portable-pty` 0.8.1, MIT
(see `LICENSE.md`). Wired in through `[patch.crates-io]` in `src-tauri/Cargo.toml` and
`src-tauri/pty-host/Cargo.toml`.

## Why it is vendored

`portable-pty` creates the Windows pseudoconsole with the flags hard-coded to
`PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE` and exposes no way to add
`PSEUDOCONSOLE_INHERIT_CURSOR`. A restored terminal needs it: the renderer replays the
previous session above the new shell, and without the flag ConPTY believes the shell's
prompt is on row 1 while the renderer's cursor is lower. The first keystroke then makes
PSReadLine repaint with an absolute `ESC[1;<col>H`, which lands on the top row of the
viewport, on top of the replayed history.

## The patch (the only difference from upstream)

* `src/win/psuedocon.rs` — `PSEUDOCONSOLE_INHERIT_CURSOR` (0x1) and a new
  `inherit_cursor: bool` argument on the private `PsuedoCon::new`.
* `src/win/conpty.rs` — `ConPtySystem::openpty_inheriting_cursor(size)`. The
  `PtySystem::openpty` trait method is unchanged in behaviour (`inherit_cursor = false`).

With the flag, ConPTY writes `ESC[6n` at startup and **the caller must answer it** with
`ESC[row;colR` on the input pipe. It does not hang if nothing answers: the startup DA1
query that follows is the sentinel, and a missing cursor reply falls back to row 1 (measured
against the bundled OpenConsole 1.24). The answering lives in
`pty-protocol/src/da1.rs`.

## Upgrading

Re-vendor the new upstream release and re-apply the two edits above (search for
`TermFlow patch`); drop this directory and the two `[patch]` entries if upstream ever exposes
the flag.
