//! Bounded, one-shot status/request-sc subprocess of the host's own image.
use crate::tcc_child::ChildOutput;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT: u64 = 4096;

fn command(mode: &str) -> std::io::Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    command.args(["--tcc", mode]);
    Ok(command)
}

pub fn run(mode: &str) -> Option<ChildOutput> {
    run_command(command(mode).ok()?, TIMEOUT, |_| {})
}

fn run_command(
    mut command: Command,
    timeout: Duration,
    on_spawn: impl FnOnce(u32),
) -> Option<ChildOutput> {
    let deadline = Instant::now().checked_add(timeout)?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    on_spawn(child.id());
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut output = Vec::new();
                child
                    .stdout
                    .take()?
                    .take(MAX_OUTPUT + 1)
                    .read_to_end(&mut output)
                    .ok()?;
                if output.len() as u64 > MAX_OUTPUT
                    || output.last() != Some(&b'\n')
                    || output[..output.len() - 1].contains(&b'\n')
                {
                    return None;
                }
                return serde_json::from_slice(&output[..output.len() - 1]).ok();
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_uses_current_exe_not_path_lookup() {
        let cmd = command("status").unwrap();
        assert_eq!(
            std::path::Path::new(cmd.get_program()),
            std::env::current_exe().unwrap()
        );
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), ["--tcc", "status"]);
    }
    #[cfg(unix)]
    #[test]
    fn timeout_kills_and_reaps_child() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "exec /bin/sleep 10"]);
        let mut pid = 0;
        assert!(run_command(cmd, Duration::from_millis(50), |p| pid = p).is_none());
        assert_ne!(pid, 0);
        // SAFETY: signal zero performs existence checking only; no process is killed.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    }
    #[cfg(unix)]
    #[test]
    fn malformed_absent_multiple_lines_and_nonzero_exit_are_unknown() {
        for script in [
            "printf 'bad\\n'",
            "exit 0",
            "printf '{}\\n{}\\n'",
            "printf '{}\\n'; exit 7",
        ] {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", script]);
            assert!(
                run_command(cmd, Duration::from_secs(2), |_| {}).is_none(),
                "{script}"
            );
        }
    }
}
