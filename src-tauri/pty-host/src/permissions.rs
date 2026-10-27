//! Permission calls never run on the session/frame loop.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use termflow_macos_tcc::{
    PermissionKind as NativeKind, PermissionState as NativeState, SystemTcc, Tcc,
};
use termflow_pty_protocol::{PermissionKind, PermissionState, Response};
use tokio::sync::mpsc::Sender;

#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;

fn convert(state: NativeState) -> PermissionState {
    match state {
        NativeState::Granted => PermissionState::Granted,
        NativeState::NotGranted => PermissionState::NotGranted,
        NativeState::Unsupported => PermissionState::Unsupported,
        NativeState::Unknown => PermissionState::Unknown,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Operation {
    Status,
    Request(PermissionKind),
}

pub(crate) trait Backend: Send + Sync {
    fn status(&self) -> (PermissionState, PermissionState);
    fn request(&self, kind: PermissionKind) -> PermissionState;
}
struct SystemBackend;
impl Backend for SystemBackend {
    fn status(&self) -> (PermissionState, PermissionState) {
        let (accessibility, screen_recording) = SystemTcc.status();
        (convert(accessibility), convert(screen_recording))
    }
    fn request(&self, kind: PermissionKind) -> PermissionState {
        let kind = match kind {
            PermissionKind::Accessibility => NativeKind::Accessibility,
            PermissionKind::ScreenRecording => NativeKind::ScreenRecording,
        };
        convert(SystemTcc.request(kind))
    }
}

#[derive(Default)]
struct State {
    generation: u64,
    active: bool,
    pending: HashMap<Operation, Vec<(u64, u64)>>,
}
pub struct Permissions {
    state: Arc<Mutex<State>>,
    backend: Arc<dyn Backend>,
    responses: Sender<Response>,
}
impl Permissions {
    pub fn new(responses: Sender<Response>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            backend: Arc::new(SystemBackend),
            responses,
        }
    }
    #[cfg(test)]
    pub fn set_backend(&mut self, backend: Arc<dyn Backend>) {
        self.backend = backend;
    }
    pub fn begin(&self) {
        let mut state = self.state.lock().unwrap();
        state.generation = state.generation.wrapping_add(1);
        state.active = true;
    }
    pub fn end(&self) {
        self.state.lock().unwrap().active = false;
    }
    fn dispatch(&self, operation: Operation, req: u64) {
        let mut state = self.state.lock().unwrap();
        if !state.active {
            return;
        }
        let generation = state.generation;
        if let Some(waiters) = state.pending.get_mut(&operation) {
            waiters.push((generation, req));
            return;
        }
        state.pending.insert(operation, vec![(generation, req)]);
        drop(state);
        let state = self.state.clone();
        let backend = self.backend.clone();
        let responses = self.responses.clone();
        std::thread::spawn(move || {
            let result = match operation {
                Operation::Status => {
                    let (a, s) = backend.status();
                    (a, s)
                }
                Operation::Request(kind) => (backend.request(kind), PermissionState::Unknown),
            };
            let mut state = state.lock().unwrap();
            let waiters = state.pending.remove(&operation).unwrap_or_default();
            for (generation, req) in waiters {
                if !state.active || state.generation != generation {
                    continue;
                }
                let response = match operation {
                    Operation::Status => Response::PermissionStatusReply {
                        req,
                        accessibility: result.0,
                        screen_recording: result.1,
                        self_responsible: None,
                    },
                    Operation::Request(kind) => Response::PermissionRequested {
                        req,
                        kind,
                        state: result.0,
                        self_responsible: None,
                    },
                };
                let _ = responses.try_send(response);
            }
        });
    }
    pub fn status(&self, req: u64) {
        self.dispatch(Operation::Status, req);
    }
    pub fn request(&self, req: u64, kind: PermissionKind) {
        self.dispatch(Operation::Request(kind), req);
    }
}
