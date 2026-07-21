//! Shared wire protocol for the TermFlow PTY-host sidecar.
//!
//! Depended on by BOTH the sidecar (`termflow-pty-host`) and the GUI backend
//! (`app`) so the two encode/decode identical frames. Keep this crate tiny and
//! dependency-light — it is compiled into two binaries.

pub mod bootstrap;
pub mod discovery;
pub mod frame;
pub mod spec;

pub use bootstrap::{
    negotiate, read_hello, write_hello, Hello, HelloKind, CAP_DRAIN, PROTOCOL_MAX, PROTOCOL_MIN,
};
pub use discovery::{
    read_record, remove_record_if_owned, write_record, HostRecord, HOST_RECORD_FORMAT,
};
pub use frame::{
    decode, encode, read_frame, write_frame, Control, Data, DecodeError, Frame, Response,
    SessionMeta, MAX_FRAME_LEN, PROTOCOL_VERSION,
};
pub use spec::SpawnSpec;
