# Review rounds ledger

One row per external review round. Letters per `~/.claude/docs/08-why-reviews-take-too-many-rounds.md`:
A = class fixed at some sites only, B = oracle identifies its subject by too few fields,
C = unsupported claim, D = genuine new defect.

| Date | Branch / ticket | Round | A | B | C | D | Note |
|---|---|---|---|---|---|---|---|
| 2026-09-22 | feature/canvas-main-only-filter PR#104 | 1 | 0 | 3 | 1 | 0 | agy: no blockers; 3 source pins too narrow (each mutation-checked after fix), `isNodePainted` doc overclaimed Arrange/regroup |
| 2026-09-29 | docs/plan/049-windows-modern-conpty-color-query | 1 | 0 | 2 | 7 | 0 | pi (sol:medium): plan blockers on real publish-windows payload, elevated host ShellExecuteExW path, atomic staging, and child OSC round-trip oracle |
| 2026-09-29 | docs/plan/049-windows-modern-conpty-color-query | 2 | 0 | 2 | 6 | 0 | pi (sol:high): plan blockers on publish-windows $RelDir mapping, elevated bundled relative lookup, directory-level atomic commit, rollback path without adjacent DLL |
| 2026-09-29 | feature/modern-conpty-color-query PR#105 | 1 | 0 | 2 | 2 | 5 | pi (sol:high): bare-name load not bound to verified bytes, signature != Microsoft pin, concurrent repair deleted published pair, swallowed staging errors, loose probe/staging oracles |
| 2026-09-30 | fix/restore-cursor-tail PR#107 | 1 | 2 | 1 | 2 | 1 | pi (sol:high): NOT ready; D: strip guard treated any LF after `?25` as content but vt100 ends the overflow-on-empty-row tail with bare LFs (fixed: CR-only guard, real-parser fixtures); A: fresh-shell hydration drops pendingOutput + new-session absolute addressing (pre-existing, out of scope); B: tests passed a truncating impl; C: "only TUI" / "no line break" claims |
| 2026-09-30 | fix/restore-cursor-tail PR#107 | 1 | 1 | 3 | 2 | 0 | agy: ready, no blockers, but called the overflow case safe (missed the LF tail); B: persist test vacuous (renders render_full_scrollback), no "first line" assert, single-marker fixtures; A: strip after concat not per chunk (fixed) |
| 2026-09-30 | fix/restore-cursor-tail PR#107 | 2 | 0 | 1 | 3 | 0 | pi (sol:high): ready, no blockers; B: multi-chunk test had one tail-bearing chunk (fixed: two legacy dumps around a rows-only chunk); C: "every tail shape" overclaim, "every row ends CR LF" / "any cursor row" comments, PR body named a test that cannot fail from the no-op mutation |
| 2026-10-22 | feature/broadcast-input-060 (plan 060 PR1) | 1 | 3 | 1 | 1 | 5 | agy (argon-high): NOT ready; D: uppercase A-Z/AltGr emitted in xterm keypress after pendingKey cleared, Enter during broadcast skipped prompt-gate disarm, paste bypassed per-target queue, pointerHeld could stick, Meta/code-point gaps in plainEncode; A: PageUp/PageDown normal-buffer guard not ported to decideKeyBytes, broadcast paste guards missing at 3 entries, live option getters snapshotted on targets; B: lock-bit test asserted only vk, parity lacked buffer/DECCKM/modifyOtherKeys axes; C: test title overclaimed. Reviewer itself mis-stated Alt+nav double-ESC (nav/tilde/fn return early) and quoted SHAs/deviations not in the report |
