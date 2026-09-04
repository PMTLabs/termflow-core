//! The list of terminals an automation could watch.
//!
//! Joins `state.terminals` (identity, shell, pid, `display_label`), `state.terminal_cwds` (OSC cwd)
//! and one shared `proc_snapshot`. A row whose `renderer_terminal_id` is `None` is filtered out of the
//! roster and every criterion including *All terminals*: a rule stores a `tm-` and every log line
//! carries one, so a terminal with no leaf could be neither stored nor described.
//!
//! `list_watchable_terminals` returns a row for every live terminal AND for each requested id that is
//! missing — filled from that rule's `automation_targets` snapshot, so a closed terminal still shows its
//! name and folder rather than a bare id. One function answering both makes the picker's greyed row
//! and the rule row's "1 not open right now" incapable of disagreeing. Plan §4.3.
//!
//! **M2 fills this in.** M0 claims the name.
