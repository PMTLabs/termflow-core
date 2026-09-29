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
