//! Resolving an automation's criterion to a set of `tm-` leaves.
//!
//! Five criteria (plan §4.4). Two of them are where the bugs live:
//!
//! - `Command contains` reads the deepest foreground descendant's full COMMAND LINE, not the process
//!   name, because an npm-installed agent is `node.exe` — which is why `detect_agent` reads the
//!   cmdline to disambiguate. It projects off `get_foreground_process_info`'s returned pid so the
//!   youngest-child descent is not implemented a third time.
//! - `Working folder is under` must NOT be a string `starts_with`. Both sides normalise through
//!   `open_commands::to_native_path` (tilde expansion, the Git-Bash/WSL `/d/...` -> `D:\...` remap,
//!   separator normalisation) because the three cwd sources genuinely disagree, and then compare
//!   COMPONENT-WISE, case-insensitive on Windows. A prefix match makes `~/work/termflow` match
//!   `~/work/termflow-site` — two rows that sit side by side in the approved mockup.
//!
//! **M2 fills this in.** M0 claims the name.
