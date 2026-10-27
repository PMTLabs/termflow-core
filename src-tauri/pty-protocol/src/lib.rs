//! Shared wire protocol for the TermFlow PTY-host sidecar.
//!
//! Depended on by BOTH the sidecar (`termflow-pty-host`) and the GUI backend
//! (`app`) so the two encode/decode identical frames. Keep this crate tiny and
//! dependency-light — it is compiled into two binaries.

pub mod bootstrap;
#[cfg(windows)]
pub mod conpty;
pub mod da1;
pub mod discovery;
pub mod frame;
pub mod pump;
pub mod rendezvous;
pub mod spec;

pub use bootstrap::{
    negotiate, read_hello, write_hello, Hello, HelloKind, CAP_ATTACH_ACK, CAP_DRAIN,
    CAP_INHERIT_CURSOR, CAP_LIFECYCLE_CONTRACT, CAP_MCP_HOLD, CAP_PERMISSIONS, CAP_SHUTDOWN_CONTROL, PROTOCOL_MAX,
    PROTOCOL_MIN,
};
pub use discovery::{
    read_record, remove_record_if_owned, write_record, HostRecord, LifecycleContract,
    RetentionPolicy, HOST_RECORD_FORMAT,
};
pub use frame::{
    decode, encode, read_frame, write_frame, ArmDetachPurpose, Control, Data, DecodeError, Frame,
    McpHeld, McpHoldReason, McpHoldSpec, PermissionKind, PermissionState, Response, SessionMeta, MAX_FRAME_LEN, PROTOCOL_VERSION,
};
pub use rendezvous::{
    elevated_stand_down_path_for_survivor, is_valid_rendezvous_pipe_name, publish_elevated_survivor,
    read_elevated_stand_down, rendezvous_pipe_name, read_elevated_survivor, read_rendezvous_request,
    read_rendezvous_response, remove_elevated_stand_down_if_owned, remove_elevated_survivor_if_owned,
    request_elevated_stand_down, write_rendezvous_request,
    write_rendezvous_response, ElevatedRendezvousRequest, ElevatedRendezvousResponse,
    ElevatedRendezvousStatus, ElevatedSurvivorRecord, ELEVATED_RENDEZVOUS_VERSION,
};
pub use spec::SpawnSpec;

/// Length of the grace period for an explicitly labelled local detach hold.
/// Unlabelled (including sibling/legacy) holds deliberately remain indefinite.
pub const LOCAL_HOLD_ACTIVE_SECS: u64 = 15 * 60;
