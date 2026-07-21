//! Unix domain socket transport.
//!
//! Security model (parallels the Windows owner-only DACL):
//! - The socket lives in a per-user runtime directory created `0700` and
//!   verified to be owned by us (rejecting a pre-existing dir we don't own).
//! - The socket file itself is `chmod 0600`.
//! - Every accepted connection is screened with a peer-credential check
//!   (`SO_PEERCRED` on Linux, `getpeereid` on macOS/BSD): only a peer whose uid
//!   matches our effective uid is served; others are dropped.
//! - The socket is unlinked on `Drop` (and a stale socket is removed before
//!   re-binding), but a path that exists and is NOT a socket is never removed.

#![cfg(unix)]

use super::Endpoint;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use tokio::net::{UnixListener, UnixStream};

/// The connected socket. Implements `AsyncRead + AsyncWrite + Unpin + Send`, so
/// the neutral serve loop drives it unchanged.
pub type Stream = UnixStream;

/// The client end (returned by `connect`). On Unix the same type serves both
/// ends; the alias exists to mirror the Windows transport surface.
pub type ClientStream = UnixStream;

/// Owns the bound `UnixListener` and unlinks the socket file on drop.
pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
}

impl Listener {
    pub fn bind(endpoint: &Endpoint) -> io::Result<Self> {
        let path = PathBuf::from(&endpoint.0);
        if let Some(dir) = path.parent() {
            ensure_owner_dir(dir)?;
        }
        // Remove a stale socket from a previous run, but refuse to clobber a
        // path that exists and is not a socket (never delete an unrelated file).
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_socket() => {
                let _ = std::fs::remove_file(&path);
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "endpoint path exists and is not a socket",
                ));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let inner = UnixListener::bind(&path)?;
        // Restrict the socket to the owner (defence in depth alongside the
        // 0700 parent dir and the per-connection peer-cred check).
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self { inner, path })
    }

    /// Accept the next owner-authenticated connection. Connections from any
    /// other uid are logged and dropped; we keep listening.
    pub async fn accept(&mut self) -> io::Result<Stream> {
        loop {
            let (stream, _addr) = self.inner.accept().await?;
            match peer_is_owner(&stream) {
                Ok(true) => return Ok(stream),
                Ok(false) => {
                    log::warn!("pty-host: rejected connection from non-owner peer");
                    continue;
                }
                Err(e) => {
                    log::warn!("pty-host: peer-cred check failed ({e}); rejecting connection");
                    continue;
                }
            }
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Connect to the host as a client (used by tests and the GUI client shim).
pub async fn connect(endpoint: &Endpoint) -> io::Result<ClientStream> {
    UnixStream::connect(&endpoint.0).await
}

/// Default socket endpoint for the host, per OS.
/// - Linux: `$XDG_RUNTIME_DIR/termflow/…` (a user-private tmpfs).
/// - macOS: `$TMPDIR/termflow/…` (no `$XDG_RUNTIME_DIR` there).
/// - Fallback: `/tmp/termflow-<uid>/…`.
/// The `dev` flag mirrors the app's dev/release isolation so a debug and a
/// release host never share a socket.
pub fn default_endpoint(dev: bool) -> Endpoint {
    let suffix = if dev { "dev" } else { "rel" };
    let path = runtime_dir().join(format!("termflow-pty-host.{suffix}.sock"));
    Endpoint(path.to_string_lossy().into_owned())
}

fn runtime_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("XDG_RUNTIME_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d).join("termflow");
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(d) = std::env::var_os("TMPDIR") {
        if !d.is_empty() {
            return PathBuf::from(d).join("termflow");
        }
    }
    let uid = unsafe { libc::geteuid() };
    PathBuf::from(format!("/tmp/termflow-{uid}"))
}

/// Create `dir` as a `0700` directory we own, or verify an existing one is a
/// directory owned by our effective uid (tightening its mode if it is loose).
/// Refuses a path owned by someone else — a squatter can't pre-create it.
fn ensure_owner_dir(dir: &Path) -> io::Result<()> {
    match std::fs::metadata(dir) {
        Ok(meta) => {
            if !meta.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "runtime path exists and is not a directory",
                ));
            }
            let euid = unsafe { libc::geteuid() };
            if meta.uid() != euid {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "runtime directory is not owned by us",
                ));
            }
            // Tighten if group/other have any access.
            if meta.permissions().mode() & 0o077 != 0 {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            std::fs::create_dir_all(dir)?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// True if the connected peer's uid equals our effective uid.
#[cfg(target_os = "linux")]
fn peer_is_owner(stream: &UnixStream) -> io::Result<bool> {
    let fd = stream.as_raw_fd();
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred`/`len` are valid for the lifetime of the call; SO_PEERCRED
    // fills `cred` with the connecting process's credentials.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid == unsafe { libc::geteuid() })
}

/// macOS/BSD flavour: `getpeereid` reports the peer's effective uid/gid.
#[cfg(not(target_os = "linux"))]
fn peer_is_owner(stream: &UnixStream) -> io::Result<bool> {
    let fd = stream.as_raw_fd();
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: both out-params are valid; getpeereid writes the peer's ids.
    let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    let _ = gid;
    Ok(uid == unsafe { libc::geteuid() })
}
