//! Native process evidence for a single foreground launch. The marker belongs
//! only to the destination argv (never the bastion or an interpreter).
use crate::pty_manager::{native_process_birth, ssh_helpers::ProcessIdentity};
use std::{ffi::OsStr, path::{Path, PathBuf}, time::{Duration, Instant}};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub(super) const NO_START: Duration = Duration::from_secs(10);
const CONFIRM_FOR: Duration = Duration::from_millis(200);

pub(super) fn marker() -> String {
    // IgnoreUnknown is a pattern list, not a command, environment value or
    // remote option. With -F none it has no configuration to ignore. It is
    // supported by inbox OpenSSH, unlike newer options such as Tag.
    format!("IgnoreUnknown=termflow-{}", uuid::Uuid::new_v4().simple())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    pid: Pid,
    birth: u64,
}

impl Identity {
    fn read(pid: Pid) -> Option<Self> {
        Some(Self { pid, birth: native_process_birth(pid.as_u32())? })
    }

    pub(crate) fn shell(identity: &ProcessIdentity) -> Option<Self> {
        let pid = Pid::from_u32(identity.pid);
        let before = Self::read(pid)?;
        (identity.is_live() && Self::read(pid)? == before).then_some(before)
    }
}

pub(super) struct Command {
    pub shell: Option<Identity>,
    pub exe: PathBuf,
    pub marker: String,
    // Only the cmd Unicode adapter launches an intermediary process. Its
    // complete command line is private, fixed by the encoder for this attempt.
    pub intermediary: Option<Vec<String>>,
}

pub(super) struct Sample {
    pub bare: bool,
    candidate: Option<Identity>,
}

impl Command {
    pub(super) fn sample(&self) -> Sample {
        let mut sample = Sample { bare: false, candidate: None };
        let Some(shell) = self.shell.filter(|s| Identity::read(s.pid) == Some(*s)) else { return sample };
        let mut system = System::new();
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        if system.process(shell.pid).is_none() { return sample; }
        let children = children_of(&system, shell.pid);
        sample.bare = children.is_empty();
        for pid in children {
            let Some(id) = Identity::read(pid) else { continue };
            let found = if self.destination(&mut system, id, shell.pid) {
                Some(id)
            } else if self.intermediary.as_ref().is_some_and(|argv| {
                inspect(&mut system, id, Some(shell.pid), |exe, cmd| {
                    same_path(exe, Path::new(&argv[0])) && cmd.len() == argv.len()
                        && cmd[1..].iter().zip(&argv[1..]).all(|(actual, expected)| actual.as_os_str() == OsStr::new(expected))
                })
            }) {
                children_of(&system, id.pid).into_iter().filter_map(Identity::read)
                    .find(|&child| self.destination(&mut system, child, id.pid))
                    .filter(|_| Identity::read(id.pid) == Some(id))
            } else {
                None
            };
            if let Some(found) = found {
                if sample.candidate.replace(found).is_some() {
                    sample.candidate = None; // ambiguous; never choose a "newest" child
                    break;
                }
            }
        }
        sample.candidate = sample.candidate.filter(|child| child.birth >= shell.birth);
        if Identity::read(shell.pid) != Some(shell) {
            return Sample { bare: false, candidate: None };
        }
        sample
    }

    /// Once correlated, sample only that incarnation, never search for a
    /// replacement SSH process. An exit or exec of a different program ends it.
    pub(super) fn sample_running(&self, child: Identity) -> Sample {
        let mut system = System::new();
        let live = inspect(&mut system, child, None, |exe, argv| self.matches_destination(exe, argv));
        Sample { bare: false, candidate: live.then_some(child) }
    }

    fn destination(&self, system: &mut System, id: Identity, parent: Pid) -> bool {
        inspect(system, id, Some(parent), |exe, argv| self.matches_destination(exe, argv))
    }

    fn matches_destination(&self, exe: &Path, argv: &[std::ffi::OsString]) -> bool {
        same_path(exe, &self.exe)
            && argv.get(1).is_some_and(|arg| arg.as_os_str() == OsStr::new("-o"))
            && argv.get(2).is_some_and(|arg| arg.as_os_str() == OsStr::new(&self.marker))
    }
}

fn children_of(system: &System, parent: Pid) -> Vec<Pid> {
    system.processes().values().filter(|p| p.parent() == Some(parent)).map(|p| p.pid()).collect()
}

fn inspect(system: &mut System, id: Identity, parent: Option<Pid>, matches: impl FnOnce(&Path, &[std::ffi::OsString]) -> bool) -> bool {
    if Identity::read(id.pid) != Some(id) { return false; }
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[id.pid]), true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always).with_cmd(UpdateKind::Always));
    system.process(id.pid).is_some_and(|p| {
        parent.is_none_or(|parent| p.parent() == Some(parent)) && p.exe().is_some_and(|exe| matches(exe, p.cmd()))
    }) && Identity::read(id.pid) == Some(id)
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        let (a, b) = (a.to_string_lossy(), b.to_string_lossy());
        a.trim_start_matches(r"\\?\").eq_ignore_ascii_case(b.trim_start_matches(r"\\?\"))
    } else {
        a == b
    }
}

#[derive(Default)]
pub(super) struct Tracker {
    seen: Option<(Identity, Instant)>,
    running: Option<Identity>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Observation { Wait, Running, Exited }

impl Tracker {
    pub(super) fn running(&self) -> Option<Identity> { self.running }

    pub(super) fn sample(&mut self, sample: &Sample, now: Instant, may_start: bool) -> Observation {
        if let Some(child) = self.running {
            return if sample.candidate == Some(child) { Observation::Wait } else { Observation::Exited };
        }
        // A person may answer an SSH prompt during the confirmation window.
        // That input cannot qualify a *different* child, but shouldn't hide
        // the exact already-observed incarnation.
        let Some(child) = sample.candidate.filter(|child| may_start || self.seen.is_some_and(|(seen, _)| seen == *child)) else {
            self.seen = None;
            return Observation::Wait;
        };
        match self.seen {
            Some((seen, since)) if seen == child => {
                if now.saturating_duration_since(since) >= CONFIRM_FOR {
                    self.running = Some(child);
                    return Observation::Running;
                }
            }
            _ => self.seen = Some((child, now)),
        }
        Observation::Wait
    }
}

#[cfg(test)]
mod tests;
