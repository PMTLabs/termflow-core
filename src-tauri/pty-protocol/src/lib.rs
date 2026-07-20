//! Shared wire protocol for the TermFlow PTY-host sidecar.
//!
//! Depended on by BOTH the sidecar (`termflow-pty-host`) and the GUI backend
//! (`app`) so the two encode/decode identical frames. Keep this crate tiny and
//! dependency-light — it is compiled into two binaries.

pub mod frame;
pub mod spec;

pub use frame::{
    decode, encode, read_frame, write_frame, Control, Data, DecodeError, Frame, Response,
    SessionMeta, MAX_FRAME_LEN, PROTOCOL_VERSION,
};
pub use spec::SpawnSpec;
