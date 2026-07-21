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
        // Handle a pre-existing socket path. Refuse to clobber a path that is not
        // a socket (never delete an unrelated file); and before removing a stale
        // socket, probe it — if a live host still answers, fail closed with
        // AddrInUse rather than orphaning the running instance (its GUI clients
        // would silently hit us instead, and its Drop would later unlink OUR
        // socket). Only a socket that refuses connection is treated as stale.
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_socket() => {
                if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "another pty-host is already listening on this socket",
                    ));
                }
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
/// Uses `symlink_metadata` (does NOT follow symlinks) and REJECTS a symlink at
/// the leaf, so an attacker cannot pre-create the path as a symlink pointing at
/// a victim-owned dir to redirect our chmod / bind / unlink (the sticky-`/tmp`
/// fallback TOCTOU). A new dir is created atomically at mode `0700` via
/// `DirBuilder` (no post-create chmod window under the umask).
fn ensure_owner_dir(dir: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "runtime directory is a symlink",
                ));
            }
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
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
        }
        Err(e) => Err(e),
    }
}

/// True if the connected peer's uid equals our effective uid.
/// Linux & Android expose `SO_PEERCRED`.
#[cfg(any(target_os = "linux", target_os = "android"))]
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
/// (Named explicitly rather than `not(linux)` so Android — which uses
/// `SO_PEERCRED` above and lacks `getpeereid` — doesn't select this arm.)
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
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

#[cfg(test)]
mod tests {
    use super::*;

    // Fix B (dual-review): a second bind to a LIVE socket must be refused with
    // AddrInUse, never silently clobber the running listener. After the live
    // listener drops (socket unlinked), a fresh bind succeeds.
    #[tokio::test]
    async fn active_socket_bind_is_refused_then_reclaimed_after_drop() {
        let ep = Endpoint(format!(
            "/tmp/termflow-test-{}/active.sock",
            std::process::id()
        ));
        let l1 = Listener::bind(&ep).expect("first bind ok");
        let err = Listener::bind(&ep)
            .map(|_| ())
            .expect_err("second bind to live socket must fail");
        assert_eq!(err.kind(), io::ErrorKind::AddrInUse, "live socket ⇒ AddrInUse");
        drop(l1);
        let _l2 = Listener::bind(&ep).expect("rebind after the live listener drops");
    }

    // Fix A (dual-review): a runtime-dir path that is a SYMLINK must be rejected
    // (an attacker in sticky /tmp could point it at a victim dir to redirect our
    // chmod/bind/unlink). ensure_owner_dir runs before any socket bind.
    #[test]
    fn symlink_runtime_dir_is_rejected() {
        use std::os::unix::fs::symlink;
        let base = format!("/tmp/termflow-test-{}-symlink", std::process::id());
        let real = format!("{base}-real");
        let link = format!("{base}-link");
        let _ = std::fs::remove_dir_all(&real);
        let _ = std::fs::remove_file(&link);
        std::fs::create_dir_all(&real).unwrap();
        symlink(&real, &link).unwrap(); // link -> a dir we own

        let ep = Endpoint(format!("{link}/x.sock")); // parent is the symlink
        let err = Listener::bind(&ep)
            .map(|_| ())
            .expect_err("symlink parent must be rejected");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&real);
    }
}
