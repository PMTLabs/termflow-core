mod types;
mod terminals;
mod host_registry;
mod host_retire;
mod host_table;
mod host_adoption;
mod host_connect;
mod host_lifecycle;
mod host_port;
mod host_routing;
mod update_survival;
mod windows;
mod history;
mod render;
mod engine_host;
mod reattach;
#[cfg(test)]
mod source_scan;

pub use types::*;
pub use render::{FocusReportingTracker, render_full_scrollback, render_tail_lines, strip_cursor_state_tail, tail_text_with};
pub use reattach::{ReattachAction, ReattachPlan, plan_reattach};
pub use host_table::{Admission, Busy, DrainGuard, DrainRefusal, HostTable, QuiesceGuard, QuiesceReason, Ticket, LIFECYCLE_BUSY};
pub use host_adoption::{Barrier, Resolution, UnresolvedHost};
pub use host_lifecycle::{offload_refusal, update_refusal, ExitReport, Hold, HostExit, OwnedHost, SiblingArm};
pub use update_survival::{describe_reasons, effective_mode, FullReason, HostOrigin, UpdateMode};
pub use host_routing::{Placement, HOST_OWNERSHIP_PENDING};
pub use host_registry::effective_session_key;
