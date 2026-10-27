//! Spawn only the host with a new session and disclaimed responsibility.
//! All allocations, environment construction and file setup happen in the
//! parent; no Rust or other non-async-signal-safe code runs after a fork.
use std::ffi::{CString, OsStr};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPermissionIdentity {
    App,
    Helper,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Spawned {
    pub pid: u32,
    pub identity: HostPermissionIdentity,
}

/// A failed attempt cannot have produced a child; posix_spawn returns a PID
/// only on success. The fallback is therefore never run after a successful spawn.
fn choose_spawn(
    disclaim: impl FnOnce() -> io::Result<u32>,
    fallback: impl FnOnce() -> io::Result<u32>,
) -> io::Result<Spawned> {
    match disclaim() {
        Ok(pid) => {
            log::info!("[HOTSWAP] pty-host spawn mode=disclaim pid={pid}");
            Ok(Spawned {
                pid,
                identity: HostPermissionIdentity::Helper,
            })
        }
        Err(error) => {
            log::warn!(
                "[HOTSWAP] pty-host disclaim failed ({error}); spawn mode=setsid identity=App"
            );
            let pid = fallback()?;
            Ok(Spawned {
                pid,
                identity: HostPermissionIdentity::App,
            })
        }
    }
}

pub(super) fn spawn_sidecar_detached(
    sidecar: &Path,
    build_id: Option<&str>,
    pipe: &str,
    token: &str,
    record: Option<&Path>,
    log_path: Option<&Path>,
) -> io::Result<Spawned> {
    if log_path.is_some() {
        super::endpoints::ensure_socket_parent(pipe)?;
    }
    let log_file = log_path.and_then(|p| File::create(p).ok());
    let mut command = Command::new(sidecar);
    command
        .env("TERMFLOW_PTY_PIPE", pipe)
        .env("TERMFLOW_PTY_TOKEN", token)
        .stdin(Stdio::null());
    match &log_file {
        Some(f) => {
            command.stdout(f.try_clone()?);
            command.stderr(f.try_clone()?);
        }
        None => {
            command.stdout(Stdio::null());
            command.stderr(Stdio::null());
        }
    }
    if let Some(id) = build_id {
        command.env("TERMFLOW_PTY_BUILD_ID", id);
    }
    if let Some(path) = record {
        command.env("TERMFLOW_PTY_RECORD", path);
    }
    if let Some(dir) = sidecar.parent() {
        command.current_dir(dir);
    }
    let command = std::cell::RefCell::new(command);
    choose_spawn(
        || spawn_disclaimed(&command.borrow(), log_file.as_ref()),
        || spawn_plain(&mut command.borrow_mut()),
    )
}

fn spawn_plain(command: &mut Command) -> io::Result<u32> {
    // The only work between fork and exec is the async-signal-safe setsid.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().map(|child| child.id())
}

fn cstring(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "NUL in spawn argument or environment",
        )
    })
}
fn check(code: libc::c_int) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}
struct Attr(libc::posix_spawnattr_t);
impl Drop for Attr {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawnattr_destroy(&mut self.0);
        }
    }
}
struct Actions(libc::posix_spawn_file_actions_t);
impl Drop for Actions {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawn_file_actions_destroy(&mut self.0);
        }
    }
}

extern "C" {
    fn posix_spawn_file_actions_addchdir_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        path: *const libc::c_char,
    ) -> libc::c_int;
}
type Disclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, bool) -> libc::c_int;

fn resolve_disclaim(symbol: *mut libc::c_void) -> io::Result<Disclaim> {
    if symbol.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "responsibility disclaim SPI unavailable",
        ));
    }
    // ABI matches macOS responsibility_spawnattrs_setdisclaim; resolved at runtime.
    Ok(unsafe { std::mem::transmute::<*mut libc::c_void, Disclaim>(symbol) })
}
fn spawn_disclaimed(command: &Command, log_file: Option<&File>) -> io::Result<u32> {
    let symbol = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"responsibility_spawnattrs_setdisclaim".as_ptr(),
        )
    };
    spawn_with_spi(command, log_file, resolve_disclaim(symbol)?)
}

fn spawn_with_spi(
    command: &Command,
    log_file: Option<&File>,
    disclaim: Disclaim,
) -> io::Result<u32> {
    let program = cstring(command.get_program())?;
    let args: Vec<CString> = std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(cstring)
        .collect::<io::Result<_>>()?;
    let mut argv: Vec<*mut libc::c_char> = args.iter().map(|s| s.as_ptr().cast_mut()).collect();
    argv.push(std::ptr::null_mut());
    let mut environment: std::collections::BTreeMap<_, _> = std::env::vars_os().collect();
    for (key, value) in command.get_envs() {
        match value {
            Some(value) => {
                environment.insert(key.to_owned(), value.to_owned());
            }
            None => {
                environment.remove(key);
            }
        }
    }
    let env: Vec<CString> = environment
        .into_iter()
        .map(|(mut key, value)| {
            key.push("=");
            key.push(value);
            cstring(&key)
        })
        .collect::<io::Result<_>>()?;
    let mut envp: Vec<*mut libc::c_char> = env.iter().map(|s| s.as_ptr().cast_mut()).collect();
    envp.push(std::ptr::null_mut());
    let mut raw_attr = std::ptr::null_mut();
    let mut raw_actions = std::ptr::null_mut();
    unsafe {
        check(libc::posix_spawnattr_init(&mut raw_attr))?;
        let mut attr = Attr(raw_attr);
        check(libc::posix_spawn_file_actions_init(&mut raw_actions))?;
        let mut actions = Actions(raw_actions);
        const POSIX_SPAWN_SETSID: libc::c_short = 0x0400;
        check(libc::posix_spawnattr_setflags(
            &mut attr.0,
            POSIX_SPAWN_SETSID | libc::POSIX_SPAWN_SETSIGDEF as libc::c_short,
        ))?;
        let mut defaults = std::mem::zeroed();
        check(libc::sigemptyset(&mut defaults))?;
        check(libc::sigaddset(&mut defaults, libc::SIGPIPE))?;
        check(libc::posix_spawnattr_setsigdefault(&mut attr.0, &defaults))?;
        check(disclaim(&mut attr.0, true))?;
        check(libc::posix_spawn_file_actions_addopen(
            &mut actions.0,
            0,
            c"/dev/null".as_ptr(),
            libc::O_RDONLY,
            0,
        ))?;
        if let Some(file) = log_file {
            check(libc::posix_spawn_file_actions_adddup2(
                &mut actions.0,
                file.as_raw_fd(),
                1,
            ))?;
            check(libc::posix_spawn_file_actions_adddup2(
                &mut actions.0,
                file.as_raw_fd(),
                2,
            ))?;
        } else {
            check(libc::posix_spawn_file_actions_addopen(
                &mut actions.0,
                1,
                c"/dev/null".as_ptr(),
                libc::O_WRONLY,
                0,
            ))?;
            check(libc::posix_spawn_file_actions_adddup2(&mut actions.0, 1, 2))?;
        }
        if let Some(dir) = command.get_current_dir() {
            let dir = cstring(dir.as_os_str())?;
            check(posix_spawn_file_actions_addchdir_np(
                &mut actions.0,
                dir.as_ptr(),
            ))?;
        }
        let mut pid = 0;
        check(libc::posix_spawn(
            &mut pid,
            program.as_ptr(),
            &actions.0,
            &attr.0,
            argv.as_ptr(),
            envp.as_ptr(),
        ))?;
        Ok(pid as u32)
    }
}

/// Trust a local spawn mode only when the connected socket is served by the
/// actual child. A raced connection, adopted host or unavailable peer PID is
/// unknown, never silently identified as Helper or App.
pub(super) fn identity_for_peer(
    spawned: Option<Spawned>,
    peer: Option<u32>,
) -> Option<HostPermissionIdentity> {
    spawned.filter(|s| Some(s.pid) == peer).map(|s| s.identity)
}
pub(super) fn peer_pid(stream: &tokio::net::UnixStream) -> Option<u32> {
    // Darwin <sys/un.h>: SOL_LOCAL=0, LOCAL_PEERPID=2.
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of_val(&pid) as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            0,
            2,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut len,
        )
    };
    (rc == 0 && len as usize == std::mem::size_of_val(&pid) && pid > 0).then_some(pid as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn missing_symbol_spi_error_and_spawn_error_fall_back_to_app() {
        for error in [
            io::ErrorKind::Unsupported,
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::Other,
        ] {
            let fallback = AtomicUsize::new(0);
            let result = choose_spawn(
                || Err(io::Error::new(error, "injected")),
                || {
                    fallback.fetch_add(1, Ordering::SeqCst);
                    Ok(22)
                },
            )
            .unwrap();
            assert_eq!(
                result,
                Spawned {
                    pid: 22,
                    identity: HostPermissionIdentity::App
                }
            );
            assert_eq!(fallback.load(Ordering::SeqCst), 1);
        }
    }
    #[test]
    fn injected_missing_symbol_and_spi_error_really_spawn_setsid() {
        unsafe extern "C" fn reject(_: *mut libc::posix_spawnattr_t, _: bool) -> libc::c_int {
            libc::EPERM
        }
        let dir = super::super::test_dirs::tempdir().unwrap();
        let binary = dir.path().join("sleep");
        std::os::unix::fs::symlink("/bin/sleep", &binary).unwrap();
        for missing in [true, false] {
            let mut command = Command::new(&binary);
            command.arg("1");
            let command = std::cell::RefCell::new(command);
            let result = choose_spawn(
                || {
                    let spi = if missing {
                        resolve_disclaim(std::ptr::null_mut())?
                    } else {
                        reject
                    };
                    spawn_with_spi(&command.borrow(), None, spi)
                },
                || spawn_plain(&mut command.borrow_mut()),
            )
            .unwrap();
            let sid = unsafe { libc::getsid(result.pid as i32) };
            let mut status = 0;
            let waited = unsafe { libc::waitpid(result.pid as i32, &mut status, 0) };
            assert_eq!(waited, result.pid as i32);
            assert_eq!(sid, result.pid as i32);
            assert_eq!(result.identity, HostPermissionIdentity::App);
            assert!(libc::WIFEXITED(status));
        }
    }
    #[test]
    fn success_records_helper_without_fallback() {
        let result = choose_spawn(|| Ok(42), || panic!("fallback on success")).unwrap();
        assert_eq!(
            result,
            Spawned {
                pid: 42,
                identity: HostPermissionIdentity::Helper
            }
        );
        assert_eq!(
            identity_for_peer(Some(result), Some(42)),
            Some(HostPermissionIdentity::Helper)
        );
        assert_eq!(identity_for_peer(Some(result), Some(43)), None);
        assert_eq!(identity_for_peer(Some(result), None), None);
        assert_eq!(identity_for_peer(None, Some(42)), None);
    }
    #[tokio::test]
    async fn peer_pid_is_read_from_connected_socket() {
        let dir = super::super::test_dirs::tempdir().unwrap();
        let listener = tokio::net::UnixListener::bind(dir.path().join("s")).unwrap();
        let client = tokio::net::UnixStream::connect(dir.path().join("s"))
            .await
            .unwrap();
        let (server, _) = listener.accept().await.unwrap();
        assert_eq!(peer_pid(&client), Some(std::process::id()));
        assert_eq!(peer_pid(&server), Some(std::process::id()));
    }
    #[test]
    fn disclaimed_spawn_preserves_environment_cwd_and_stdio() {
        let dir = super::super::test_dirs::tempdir().unwrap();
        let log = File::create(dir.path().join("output")).unwrap();
        let mut command = Command::new("/usr/bin/python3");
        command.arg("-c").arg("import os; print('env=' + os.environ['TF_TEST_SPAWN']); print('removed=' + str('TF_TEST_REMOVE' not in os.environ)); print('cwd=' + os.getcwd()); print('stdin=' + str(os.read(0, 1) == b'')); os.write(2, b'stderr-marker')")
            .env("TF_TEST_SPAWN", "value with spaces").env_remove("TF_TEST_REMOVE").current_dir(dir.path());
        let pid = spawn_disclaimed(&command, Some(&log)).unwrap();
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid as i32, &mut status, 0) },
            pid as i32
        );
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
        let output = std::fs::read_to_string(dir.path().join("output")).unwrap();
        for expected in [
            "env=value with spaces",
            "removed=True",
            "stdin=True",
            "stderr-marker",
        ] {
            assert!(output.contains(expected), "missing {expected}: {output}");
        }
        assert!(output.contains(&format!(
            "cwd={}",
            std::fs::canonicalize(dir.path()).unwrap().display()
        )));
    }
    #[test]
    fn real_disclaimed_child_is_session_leader_and_reaped() {
        let dir = super::super::test_dirs::tempdir().unwrap();
        let binary = dir.path().join("sleep");
        std::os::unix::fs::symlink("/bin/sleep", &binary).unwrap();
        let mut command = Command::new(&binary);
        command.arg("2");
        let pid = spawn_disclaimed(&command, None).expect("disclaim SPI and spawn available");
        let sid = unsafe { libc::getsid(pid as i32) };
        let mut status = 0;
        let waited = unsafe { libc::waitpid(pid as i32, &mut status, 0) };
        assert_eq!(waited, pid as i32);
        assert_eq!(sid, pid as i32);
        assert!(libc::WIFEXITED(status));
        assert_eq!(libc::WEXITSTATUS(status), 0);
    }
}
