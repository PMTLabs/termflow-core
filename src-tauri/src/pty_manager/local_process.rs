//! A deferred tree kill must keep the original child object alive. On Windows
//! its process handle reserves the root PID even if the shell exits meanwhile.

use std::sync::Arc;

#[derive(Clone)]
pub struct LocalProcess {
    pid: u32,
    retained: Arc<dyn Send + Sync>,
}

impl LocalProcess {
    pub fn new(child: Box<dyn portable_pty::Child + Send + Sync>) -> Self {
        Self { pid: child.process_id().unwrap_or(0), retained: Arc::new(child) }
    }
}

pub fn kill_process_tree(process: LocalProcess) {
    if process.pid == 0 { return; }
    kill_worker(process, |process| kill_process_tree_blocking(process.pid));
}

fn kill_worker(process: LocalProcess, effect: impl FnOnce(&LocalProcess) + Send + 'static) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        effect(&process);
        // Keep the handle through completion of taskkill, not just dispatch.
        drop(process.retained);
    })
}

fn kill_process_tree_blocking(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &format!("-{}", pid)])
            .output();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, mpsc};
    use std::time::Duration;

    struct Reservation(Arc<Mutex<Option<&'static str>>>);
    impl Drop for Reservation {
        fn drop(&mut self) { *self.0.lock().unwrap() = None; }
    }

    #[test]
    fn deferred_kill_worker_retains_the_original_capability_through_the_effect() {
        // Simulate the OS rule: a retained process object reserves its PID.
        // This seam replaces only the blocking OS command, not the worker.
        let reserved = Arc::new(Mutex::new(Some("P")));
        let process = LocalProcess { pid: 42, retained: Arc::new(Reservation(reserved.clone())) };
        let (reached_tx, reached) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let (killed_tx, killed) = mpsc::channel();
        let held = reserved.clone();
        let worker = kill_worker(process, move |process| {
            reached_tx.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(3)).unwrap();
            let incarnation = *held.lock().unwrap();
            killed_tx.send((process.pid, incarnation)).unwrap();
            assert_eq!(incarnation, Some("P"));
        });
        reached.recv_timeout(Duration::from_secs(3)).unwrap();
        // P may have exited, but Q cannot take 42 while the worker holds P.
        assert_eq!(*reserved.lock().unwrap(), Some("P"));
        release.send(()).unwrap();
        assert_eq!(killed.recv_timeout(Duration::from_secs(3)).unwrap(), (42, Some("P")));
        worker.join().unwrap();
        assert_eq!(*reserved.lock().unwrap(), None);
        *reserved.lock().unwrap() = Some("Q");
        assert_eq!(*reserved.lock().unwrap(), Some("Q"));
    }

    #[test]
    fn local_lifecycle_moves_a_retained_child_to_both_kill_paths() {
        let spawn = include_str!("spawn.rs").split("#[cfg(test)]").next().unwrap();
        assert!(spawn.contains("LocalProcess::new(child)"));
        assert!(spawn.contains("UnpublishedChild(Some(process.clone()))"));
        assert!(spawn.contains("local_processes.insert(id.clone(), process)"));
        let owner = include_str!("../state/owner_lifecycle.rs").split("#[cfg(test)]").next().unwrap();
        assert_eq!(owner.matches("kill_process_tree(process)").count(), 2);
        assert!(!owner.contains("kill_process_tree(pid)"));
    }
}
