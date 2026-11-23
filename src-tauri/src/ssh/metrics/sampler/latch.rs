use super::{classify, protocol, ExecOutcome, Reading};
use crate::ssh::metrics::{protocol::Platform, UNAVAILABLE_EXIT};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Collector {
    #[default]
    FirstPosix,
    ProbeWindows,
    Posix,
    Windows,
}

fn should_probe_windows(exit: u32, stdout: &[u8]) -> bool {
    exit != 0 && exit != UNAVAILABLE_EXIT && !protocol::has_frame_begin(stdout)
}

impl Collector {
    pub(super) fn uses_windows(self) -> bool {
        matches!(self, Self::ProbeWindows | Self::Windows)
    }

    pub(super) fn read<'a>(self, outcome: &'a ExecOutcome, nonce: &str) -> (Reading<'a>, Self) {
        let reading = classify(outcome, nonce);
        match self {
            Self::FirstPosix if outcome.cleanup_failure.is_none() => {
                let next = match &outcome.result {
                    Ok(output) if should_probe_windows(output.exit, &output.stdout) => {
                        Self::ProbeWindows
                    }
                    Ok(_) => Self::Posix,
                    Err(_) => Self::FirstPosix,
                };
                (reading, next)
            }
            Self::ProbeWindows => {
                let raw = match &reading {
                    Reading::Sample(raw)
                    | Reading::IndeterminateRemoteWork {
                        completed: Some(raw),
                        ..
                    } => Some(raw),
                    _ => None,
                };
                if raw.is_some_and(|raw| raw.platform == Platform::Windows) {
                    (reading, Self::Windows)
                } else {
                    // A probe cannot hide the original command failure or weaken
                    // timeout/cleanup protection. Do not emit a non-Windows frame.
                    let result = match reading {
                        Reading::IndeterminateRemoteWork { reason, .. } => {
                            Reading::IndeterminateRemoteWork {
                                reason,
                                completed: None,
                            }
                        }
                        Reading::Discard { .. } => reading,
                        _ => Reading::Unavailable("Metrics command failed"),
                    };
                    (result, Self::Posix)
                }
            }
            _ => (reading, self),
        }
    }
}

#[cfg(test)]
mod tests;
