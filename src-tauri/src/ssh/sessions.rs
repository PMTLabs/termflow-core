//! Registry-scoped façade used by 066/068/069; no process-global manager.
use super::session::{CurrentLaunch, LaunchState, SessionError, SessionRegistry, SshSession};
use std::{future::Future, sync::Arc};
pub async fn with_session<T, F, Fut>(
    registry: &SessionRegistry,
    terminal_id: &str,
    operation: F,
) -> Result<T, SessionError>
where
    F: FnOnce(Arc<SshSession>) -> Fut,
    Fut: Future<Output = Result<T, SessionError>>,
{
    let lease = registry.lease(terminal_id)?;
    let cancel = lease.cancellation();
    // Operations own cancellation cleanup (including joining channel readers).
    let result = operation(lease).await;
    if cancel.is_cancelled() {
        Err(SessionError::Cancelled)
    } else {
        result
    }
}
pub fn current_launch(registry: &SessionRegistry, terminal_id: &str) -> Option<CurrentLaunch> {
    registry.current_launch(terminal_id)
}
pub fn on_launch_lifecycle(
    registry: &SessionRegistry,
    terminal_id: &str,
    generation: u64,
    launch_seq: u64,
    state: LaunchState,
    process_id: Option<String>,
) -> Result<(), SessionError> {
    registry.on_launch_lifecycle(terminal_id, generation, launch_seq, state, process_id)
}
