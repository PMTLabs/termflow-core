//! Git for Windows keeps the real interactive shell below its launcher.
use crate::pty_manager::ssh_helpers::ProcessIdentity;
use std::collections::HashMap;

struct Process {
    parent: Option<u32>,
    // Canonical, case-folded Windows path with backslash separators.
    exe: Option<String>,
    identity: Option<ProcessIdentity>,
}

type Snapshot = HashMap<u32, Process>;

fn is_child(process: &Process, parent: &ProcessIdentity) -> bool {
    // Windows retains numeric parent PIDs even after they are reused.
    process.parent == Some(parent.pid)
        && process
            .identity
            .as_ref()
            .is_none_or(|child| child.start_time >= parent.start_time)
}

fn bare(
    processes: &Snapshot,
    shell: &ProcessIdentity,
    pinned: &mut Option<ProcessIdentity>,
    expected_leaf: Option<&str>,
) -> bool {
    let Some(launcher) = processes.get(&shell.pid) else {
        return false;
    };
    if launcher.identity.as_ref() != Some(shell) {
        return false;
    }
    let mut children = processes
        .values()
        .filter(|process| is_child(process, shell));
    let child = children.next();
    if let Some(leaf) = pinned.as_ref() {
        return child.is_some_and(|child| child.identity.as_ref() == Some(leaf))
            && children.next().is_none()
            && !processes.values().any(|p| is_child(p, leaf));
    }
    let Some(expected_leaf) = expected_leaf else {
        return child.is_none();
    };
    let Some(child) = child else { return false };
    if children.next().is_some() || child.exe.as_deref() != Some(expected_leaf) {
        return false;
    }
    let Some(leaf) = child.identity.clone() else {
        return false;
    };
    let idle = !processes.values().any(|p| is_child(p, &leaf));
    *pinned = Some(leaf);
    idle
}

#[cfg(windows)]
pub(super) fn native(bound: &crate::pty_manager::input_gate::BoundSshShell) -> bool {
    use std::path::Path;
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let Some((effective, _)) = bound.effective_identity() else {
        return false;
    };
    let (identity, pinned) = bound.launcher_for_leaf_resolution();
    let mut pinned = pinned.lock();
    if pinned.as_ref().is_some_and(|leaf| *leaf != effective) {
        return false;
    }
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let pid = Pid::from_u32(identity.pid);
    // Only the launcher and its direct children are ever compared by exe.
    let with_exe: Vec<Pid> = system
        .processes()
        .values()
        .filter(|p| p.pid() == pid || p.parent() == Some(pid))
        .map(|p| p.pid())
        .collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&with_exe),
        false,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    let Some(process) = system.process(pid) else {
        return false;
    };
    if !Path::new(&bound.shell).file_name().is_some_and(|name| {
        name.to_string_lossy()
            .eq_ignore_ascii_case(&process.name().to_string_lossy())
    }) {
        return false;
    }
    let canonical_exe = |process: &sysinfo::Process| {
        let path = process.exe()?.canonicalize().ok()?;
        Some(path.to_str()?.to_lowercase())
    };
    let launcher_exe = canonical_exe(process);
    if launcher_exe.is_none() && process.name().eq_ignore_ascii_case("bash.exe") {
        return false;
    }
    let expected_leaf = launcher_exe
        .as_deref()
        .and_then(|exe| exe.strip_suffix(r"\bin\bash.exe"))
        .filter(|root| !root.ends_with(r"\usr"))
        .map(|root| format!(r"{root}\usr\bin\bash.exe"))
        .filter(|path| Path::new(path).is_file());
    let mut processes: Snapshot = system
        .processes()
        .iter()
        .map(|(&id, process)| {
            let parent = process.parent();
            let direct = parent == Some(pid);
            let exe = if direct && expected_leaf.is_some() {
                canonical_exe(process)
            } else {
                None
            };
            (
                id.as_u32(),
                Process {
                    parent: parent.map(Pid::as_u32),
                    exe,
                    identity: (id == pid || direct)
                        .then(|| ProcessIdentity::capture(id.as_u32()).ok())
                        .flatten(),
                },
            )
        })
        .collect();
    let leaf_pid = pinned.as_ref().map(|leaf| leaf.pid).or_else(|| {
        let expected = expected_leaf.as_deref()?;
        let mut children = processes.values().filter(|child| is_child(child, identity));
        let child = children.next()?;
        if children.next().is_none() && child.exe.as_deref() == Some(expected) {
            child.identity.as_ref().map(|leaf| leaf.pid)
        } else {
            None
        }
    });
    if let Some(leaf_pid) = leaf_pid {
        for (&id, child) in &mut processes {
            if child.parent == Some(leaf_pid) {
                child.identity = ProcessIdentity::capture(id).ok();
            }
        }
    }
    bare(&processes, identity, &mut pinned, expected_leaf.as_deref())
}

#[cfg(test)]
pub(super) fn launcher_without_child_is_bare() -> bool {
    let shell = ProcessIdentity {
        pid: 1,
        start_time: 10,
    };
    let tree = [(
        shell.pid,
        Process {
            parent: None,
            exe: Some(r"c:\git\bin\bash.exe".into()),
            identity: Some(shell.clone()),
        },
    )]
    .into();
    bare(&tree, &shell, &mut None, Some(r"c:\git\usr\bin\bash.exe"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAUNCHER: &str = r"c:\git\bin\bash.exe";
    const LEAF: &str = r"c:\git\usr\bin\bash.exe";
    const SHELL: ProcessIdentity = ProcessIdentity {
        pid: 1,
        start_time: 10,
    };

    fn process(pid: u32, parent: Option<u32>, exe: &str) -> (u32, Process) {
        (
            pid,
            Process {
                parent,
                exe: Some(exe.into()),
                identity: Some(ProcessIdentity {
                    pid,
                    start_time: u64::from(pid) * 10,
                }),
            },
        )
    }

    fn pair() -> Snapshot {
        [process(1, None, LAUNCHER), process(2, Some(1), LEAF)].into()
    }

    #[test]
    fn valid_pair_is_bare_and_pins_its_leaf() {
        let mut pin = None;
        assert!(bare(&pair(), &SHELL, &mut pin, Some(LEAF)));
        assert_eq!(
            pin,
            Some(ProcessIdentity {
                pid: 2,
                start_time: 20
            })
        );
        assert!(bare(&pair(), &SHELL, &mut pin, Some(LEAF)));
    }

    #[test]
    fn nested_bash_keeps_leaf_busy_before_and_after_pinning() {
        let mut tree = pair();
        tree.extend([process(3, Some(2), LEAF)]);
        let mut pin = None;
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert_eq!(pin.as_ref().map(|p| p.pid), Some(2));
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
    }

    #[test]
    fn leaf_with_child_and_grandchild_stays_busy() {
        let mut tree = pair();
        let mut pin = None;
        assert!(bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        // Child and grandchild exes are deliberately unknown: only the
        // launcher's direct children have exe read, and busy must not need it.
        let mut child = process(3, Some(2), LEAF);
        child.1.exe = None;
        let mut grandchild = process(4, Some(3), r"c:\git\usr\bin\less.exe");
        grandchild.1.exe = None;
        tree.extend([child, grandchild]);
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert_eq!(pin.as_ref().map(|p| p.pid), Some(2), "pin never moves to the child");
    }

    #[test]
    fn same_name_from_another_root_is_not_accepted() {
        let mut tree = pair();
        tree.extend([process(2, Some(1), r"d:\other\usr\bin\bash.exe")]);
        assert!(!bare(&tree, &SHELL, &mut None, Some(LEAF)));
    }

    #[test]
    fn launcher_without_child_waits() {
        assert!(!launcher_without_child_is_bare());
    }

    #[test]
    fn grandchild_and_multiple_direct_children_are_not_accepted() {
        let mut tree = pair();
        tree.extend([
            process(2, Some(1), r"c:\git\shim.exe"),
            process(3, Some(2), LEAF),
        ]);
        let mut pin = None;
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert!(pin.is_none());
        tree.extend([process(3, Some(1), LEAF)]);
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert!(pin.is_none());
    }

    #[test]
    fn pinned_leaf_never_moves_or_accepts_pid_reuse() {
        let mut tree = pair();
        let mut pin = None;
        assert!(bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        let original = pin.clone();
        tree.get_mut(&2)
            .unwrap()
            .identity
            .as_mut()
            .unwrap()
            .start_time += 1;
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        tree.remove(&2);
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        tree.extend([process(3, Some(1), LEAF)]);
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert_eq!(pin, original);
    }

    #[test]
    fn unreadable_launcher_child_is_busy_and_never_pinned() {
        let mut tree = pair();
        tree.get_mut(&2).unwrap().identity = None;
        let mut pin = None;
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert!(pin.is_none());
        tree.extend([process(3, Some(1), LEAF)]);
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert!(pin.is_none());
    }

    #[test]
    fn unreadable_child_of_pinned_leaf_is_busy() {
        let mut tree = pair();
        let mut pin = None;
        assert!(bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        let mut opaque = process(3, Some(2), LEAF);
        opaque.1.identity = None;
        tree.extend([opaque]);
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
    }

    #[test]
    fn stale_launcher_child_cannot_block_or_take_the_pin() {
        let mut stale = process(3, Some(1), LEAF);
        stale.1.identity.as_mut().unwrap().start_time = 9;
        let mut tree: Snapshot = [process(1, None, LAUNCHER), stale].into();
        let mut pin = None;
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert!(pin.is_none());
        tree.extend([process(2, Some(1), LEAF)]);
        assert!(bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert_eq!(pin.as_ref().map(|p| p.pid), Some(2));
    }

    #[test]
    fn stale_leaf_child_is_ignored_but_younger_child_blocks() {
        let mut tree = pair();
        let mut stale = process(3, Some(2), LEAF);
        stale.1.identity.as_mut().unwrap().start_time = 19;
        tree.extend([stale]);
        let mut pin = None;
        assert!(bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert!(bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        tree.extend([process(3, Some(2), LEAF)]);
        assert!(!bare(&tree, &SHELL, &mut pin, Some(LEAF)));
        assert!(!bare(&tree, &SHELL, &mut None, Some(LEAF)));
    }

    #[test]
    fn ordinary_shell_without_children_is_bare() {
        for exe in [
            LEAF,
            r"c:\cygwin64\bin\bash.exe",
            r"c:\msys64\usr\bin\bash.exe",
            r"c:\windows\powershell.exe",
        ] {
            assert!(bare(
                &[process(1, None, exe)].into(),
                &SHELL,
                &mut None,
                None
            ));
        }
    }
}
