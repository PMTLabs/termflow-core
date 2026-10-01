mod types;
mod incarnation_ids;
mod host_routes;
mod host_keys;
mod terminals;
mod owner_lifecycle;
pub(crate) use owner_lifecycle::CreateGuard;
mod host_registry;
mod host_retire;
mod host_table;
mod host_adoption;
mod host_connect;
mod host_lifecycle;
mod host_port;
mod host_routing;
mod host_generation;
mod update_survival;
mod update_full;
mod windows;
mod history;
pub(crate) mod leaf_storage;
#[cfg(test)]
mod leaf_storage_tests;
#[cfg(test)]
mod storage_wiring_tests;
mod render;
mod engine_host;
mod reattach;
#[cfg(test)]
pub(crate) mod source_scan;
#[cfg(test)]
mod wiring_tests;
#[cfg(test)]
mod owner_wiring_tests;
#[cfg(test)]
pub(crate) use host_adoption::wiring_tests::exercise_generations;

pub use types::*;
pub use incarnation_ids::{IdAllocator, mint_process_id, mint_session_key, parse_session_key, restore_candidate, SessionKeyKind};
pub use host_routes::HostRoutes;
pub use host_keys::{HostKeys, KeyState, CloseState, KeyStage, StageMode, CreateAdmission, CreateMode, CloseStorage, EndKind, ShellStage, StagedShell, OwnerState, Completion, CloseAction, JOIN_DEADLINE};
pub use render::{FocusReportingTracker, render_full_scrollback, render_tail_lines, strip_cursor_state_tail, tail_text_with};
pub use reattach::{ReattachAction, ReattachPlan, plan_reattach};
pub use host_table::{Admission, Busy, DrainGuard, DrainRefusal, HostTable, QuiesceGuard, QuiesceReason, Ticket, LIFECYCLE_BUSY};
pub use host_adoption::{Barrier, Resolution, UnresolvedHost};
pub use host_lifecycle::{offload_refusal, update_refusal, CloseBounds, ExitReport, Hold, HostExit, OwnedHost, SiblingArm};
pub use update_survival::{describe_reasons, effective_mode, FullReason, HostOrigin, UpdateMode};
pub use update_full::{Availability, ConfirmToken, Confirmation, FullRun, Target};
pub use host_routing::{Placement, HOST_OWNERSHIP_PENDING};
pub use host_registry::effective_session_key;
pub use host_generation::{generation_marker, Marker, TERMINAL_GENERATIONS_EVENT};
