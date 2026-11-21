use super::{Entry, EntryState, LaunchState, SessionRegistry, SessionState};
use crate::{pty_manager::osc7::Osc7, state::ChannelPayload};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CwdEvent {
    pub terminal_id: String,
    pub path: String,
    pub host: String,
    pub session_generation: u64,
}

/// Like the session state sink, this queues an event synchronously and must not
/// call back into the registry. No renderer acknowledgment is needed.
pub(crate) trait CwdEventSink {
    fn emit_cwd(&self, event: CwdEvent);
}

impl<F: Fn(CwdEvent)> CwdEventSink for F {
    fn emit_cwd(&self, event: CwdEvent) {
        self(event);
    }
}

#[derive(Default)]
pub(super) struct CwdStreams {
    pipeline_generation: u64,
    by_process: HashMap<String, Stream>,
}

struct Stream {
    terminal_id: String,
    session_generation: u64,
    launch_seq: u64,
    parser: Osc7,
    pending: Option<CwdEvent>,
}

impl CwdStreams {
    pub(super) fn forget_launch(&mut self, state: &EntryState) {
        if let Some((terminal_id, process_id)) =
            state.view.terminal_id.as_deref().zip(state.process_id.as_deref())
        {
            self.forget_process(terminal_id, process_id, Some(state.view.generation));
        }
    }

    fn forget_process(&mut self, terminal_id: &str, process_id: &str, generation: Option<u64>) {
        if self.by_process.get(process_id).is_some_and(|stream| {
            stream.terminal_id == terminal_id
                && generation.is_none_or(|generation| generation == stream.session_generation)
        }) {
            self.by_process.remove(process_id);
        }
    }
}

pub(super) fn active(entry: &Entry, state: &EntryState, process_id: &str) -> bool {
    !entry.cancel.is_cancelled()
        && state.view.state == SessionState::Connected
        && state.launch == Some(LaunchState::Running)
        && state.process_id.as_deref() == Some(process_id)
}

impl SessionRegistry {
    // Lock order: registry -> entry -> cwd streams. Transport callbacks may
    // invalidate a launch with just entry -> cwd streams; no network await
    // holds any of these locks.
    pub(crate) fn begin_cwd_pipeline(&self, generation: u64) {
        let _registry = self.inner.lock();
        let mut streams = self.cwd_streams.lock();
        if generation >= streams.pipeline_generation {
            streams.pipeline_generation = generation;
            streams.by_process.clear();
        }
    }

    pub(crate) fn reset_cwd_pipeline(&self, generation: u64) {
        let _registry = self.inner.lock();
        let mut streams = self.cwd_streams.lock();
        if generation == streams.pipeline_generation {
            streams.by_process.clear();
        }
    }

    pub(crate) fn remove_cwd_process(
        &self,
        terminal_id: Option<&str>,
        process_id: &str,
        remove_mapping: impl FnOnce(),
    ) {
        let _registry = self.inner.lock();
        if let Some(terminal_id) = terminal_id {
            self.cwd_streams.lock().forget_process(terminal_id, process_id, None);
        }
        // Keep ingest serialized with the purge and mapping removal, so late
        // buffered bytes cannot recreate the just-deleted parser.
        remove_mapping();
    }

    pub(crate) fn feed_remote_cwd(
        &self,
        generation: u64,
        payload: &ChannelPayload,
        resolve_leaf: impl FnOnce(&str) -> Option<String>,
    ) {
        let registry = self.inner.lock();
        // Hot path for every terminal's output: skip the leaf lookup when no SSH pane exists.
        if registry.panes.is_empty() { return; }
        let Some(terminal_id) = resolve_leaf(&payload.id) else { return };
        let Some(entry) = registry.panes.get(&terminal_id) else { return };
        let state = entry.inner.lock();
        if !active(entry, &state, &payload.id) {
            return;
        }
        let mut streams = self.cwd_streams.lock();
        if streams.pipeline_generation != generation {
            return;
        }
        let session_generation = state.view.generation;
        let new_stream = || Stream {
            terminal_id: terminal_id.clone(),
            session_generation,
            launch_seq: state.launch_seq,
            parser: Osc7::default(),
            pending: None,
        };
        let stream = streams.by_process.entry(payload.id.clone()).or_insert_with(new_stream);
        if stream.session_generation != session_generation || stream.launch_seq != state.launch_seq
            || stream.terminal_id != terminal_id
        {
            *stream = new_stream();
        }
        let Stream { terminal_id, parser, pending, .. } = stream;
        parser.feed(&payload.data, |cwd| {
            if !cwd.host.is_empty()
                && (state.target_host.as_deref() == Some(cwd.host.as_str())
                    || state.learned_hostname.as_deref() == Some(cwd.host.as_str()))
            {
                *pending = Some(CwdEvent {
                    terminal_id: terminal_id.clone(),
                    path: cwd.path,
                    host: cwd.host,
                    session_generation,
                });
            }
        });
    }

    pub(crate) fn flush_remote_cwd(
        &self,
        generation: u64,
        resolve_leaf: impl Fn(&str) -> Option<String>,
        sink: &impl CwdEventSink,
    ) {
        let registry = self.inner.lock();
        let pending: Vec<_> = {
            let mut streams = self.cwd_streams.lock();
            if streams.pipeline_generation != generation {
                return;
            }
            streams.by_process.iter_mut().filter_map(|(id, stream)| {
                let event = stream.pending.take()?;
                Some((id.clone(), stream.launch_seq, event))
            }).collect()
        };
        for (process_id, launch_seq, event) in pending {
            let Some(entry) = registry.panes.get(&event.terminal_id) else { continue };
            let state = entry.inner.lock();
            if active(entry, &state, &process_id)
                && state.view.generation == event.session_generation
                && state.launch_seq == launch_seq
                && resolve_leaf(&process_id).as_deref() == Some(event.terminal_id.as_str())
            {
                sink.emit_cwd(event);
            }
        }
    }
}

#[cfg(test)]
mod tests;
