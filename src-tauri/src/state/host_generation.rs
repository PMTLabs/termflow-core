//! Whether the host serving a terminal belongs to the build that is running.
//!
//! A host survives an update, so a terminal can be served by a host older than
//! the app showing it. The renderer marks such a tab. "Older" is a statement
//! about the host's *generation* (its install directory: the host binary plus the
//! ConPTY pair that ships with it), not about its build id: a release that changes
//! only the ConPTY pair leaves the host file untouched and must still show the
//! marker.
//!
//! The marker errs towards `Previous`. It is `Current` only when the host is
//! shown to be the running build's, so a host whose generation cannot be read is
//! reported as older rather than silently trusted.

use super::host_registry;
use super::types::{AppState, FrozenHost, Terminal};
use crate::elevated_host::HostChannel;
use crate::pty_host_client::PtyHostClient;
use dashmap::DashMap;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{Emitter, Runtime};

/// Event telling every window that which terminals are on an older host may have
/// changed. It carries nothing: the receiver asks `get_terminal_generations`.
pub const TERMINAL_GENERATIONS_EVENT: &str = "terminal:generations";

/// Serialised as `"current"` / `"previous"`: the `generation` of a terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Marker {
    Current,
    Previous,
}

impl Marker {
    pub fn as_str(self) -> &'static str {
        match self {
            Marker::Current => "current",
            Marker::Previous => "previous",
        }
    }
}

/// `Current` only when both generations are known and equal. A host whose
/// generation cannot be shown, or a running build with none, is `Previous`.
pub fn generation_marker(host: Option<&str>, running: Option<&str>) -> Marker {
    match (host, running) {
        (Some(host), Some(running)) if host == running => Marker::Current,
        _ => Marker::Previous,
    }
}

/// What is known about whatever serves a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Serving {
    /// The shell runs in this process, or on a host this app started from its own
    /// resolved binary: either way it is the running build's by construction.
    Ours,
    /// A host some other process started, with its generation if it can be shown.
    Host(Option<String>),
}

/// The hosts that can serve a terminal, as they are at one moment.
pub(crate) struct ServingHosts {
    /// The current-role host's connection, if one is up.
    pub primary: Option<PtyHostClient>,
    /// Generation named by the current host's endpoint; `None` for the legacy
    /// endpoint, which names none.
    pub primary_generation: Option<String>,
    pub frozen: Vec<FrozenHost>,
}

impl ServingHosts {
    /// The hosts as they are now. `primary_endpoint` is the current host's
    /// endpoint, or `None` when no terminal is on it and there is nothing to
    /// name; `generation_of` reads the generation an endpoint is named after.
    pub(crate) fn assemble(
        primary: Option<PtyHostClient>,
        primary_endpoint: Option<&str>,
        generation_of: impl Fn(&str) -> Option<String>,
        frozen: Vec<FrozenHost>,
    ) -> Self {
        Self { primary, primary_generation: primary_endpoint.and_then(generation_of), frozen }
    }

    pub(crate) fn serving(&self, channel: Option<HostChannel>) -> Serving {
        match channel {
            // Not a host terminal, or the elevated host, which only this app
            // starts and never adopts.
            None | Some(HostChannel::Elevated) => Serving::Ours,
            Some(HostChannel::Primary) => match &self.primary {
                Some(client) if client.spawned_here() => Serving::Ours,
                // The endpoint of a qualified current host is named after the
                // generation; only a host on the legacy endpoint has to be asked
                // where it runs from.
                client => Serving::Host(
                    self.primary_generation
                        .clone()
                        .or_else(|| client.as_ref().and_then(PtyHostClient::host_generation)),
                ),
            },
            Some(HostChannel::Frozen(id)) => match self.frozen.iter().find(|h| h.id == id) {
                Some(host) => Serving::Host(host.generation.clone().or_else(|| host.client.host_generation())),
                // Retired between looking up the terminal and the host.
                None => Serving::Host(None),
            },
        }
    }

    pub(crate) fn marker(&self, channel: Option<HostChannel>, running: Option<&str>) -> Marker {
        match self.serving(channel) {
            Serving::Ours => Marker::Current,
            Serving::Host(generation) => generation_marker(generation.as_deref(), running),
        }
    }
}

/// The marker of each of `terminals`, in the same order. Each host is asked once
/// however many terminals it serves.
pub(crate) fn markers_of(
    terminals: &[Terminal],
    host_terminals: &DashMap<String, HostChannel>,
    hosts: &ServingHosts,
    running: Option<&str>,
) -> Vec<Marker> {
    let mut by_channel: Vec<(Option<HostChannel>, Marker)> = Vec::new();
    terminals
        .iter()
        .map(|terminal| {
            let channel = host_terminals.get(&terminal.id).map(|c| *c.value());
            match by_channel.iter().find(|(known, _)| *known == channel) {
                Some((_, marker)) => *marker,
                None => {
                    let marker = hosts.marker(channel, running);
                    by_channel.push((channel, marker));
                    marker
                }
            }
        })
        .collect()
}

/// The marker of each terminal that has a renderer pane, by leaf id, which is
/// what a tab knows its terminals by. A terminal with no pane has no tab to mark.
pub(crate) fn markers_by_leaf(terminals: &[Terminal], markers: &[Marker]) -> HashMap<String, Marker> {
    terminals
        .iter()
        .zip(markers)
        .filter_map(|(terminal, marker)| Some((terminal.renderer_terminal_id.clone()?, *marker)))
        .collect()
}

impl<R: Runtime> AppState<R> {
    fn serving_hosts(&self) -> ServingHosts {
        let primary_terminals = self.host_terminals.iter().any(|e| *e.value() == HostChannel::Primary);
        let primary_endpoint = primary_terminals.then(|| crate::pty_host_client::current_host_paths().endpoint);
        ServingHosts::assemble(
            self.pty_host_clone(),
            primary_endpoint.as_deref(),
            crate::pty_host_client::generation_of_endpoint,
            host_registry::frozen_hosts_snapshot(&self.frozen_hosts),
        )
    }

    /// The markers of `terminals` against the hosts as they are now and the
    /// running build's generation: the one place the two are put together.
    fn markers_for(&self, terminals: &[Terminal]) -> Vec<Marker> {
        markers_of(
            terminals,
            &self.host_terminals,
            &self.serving_hosts(),
            crate::pty_host_client::running_generation().as_deref(),
        )
    }

    /// Every registered terminal with its marker, taken from one snapshot so the
    /// two cannot disagree about which terminals exist.
    pub fn terminals_with_markers(&self) -> Vec<(Terminal, Marker)> {
        let terminals: Vec<Terminal> = self.terminals.iter().map(|e| e.value().clone()).collect();
        let markers = self.markers_for(&terminals);
        terminals.into_iter().zip(markers).collect()
    }

    /// The marker of one terminal.
    pub fn terminal_marker(&self, terminal: &Terminal) -> Marker {
        self.markers_for(std::slice::from_ref(terminal))[0]
    }

    /// The marker of every terminal that has a renderer pane, by leaf id.
    pub fn terminal_markers_by_leaf(&self) -> HashMap<String, Marker> {
        let (terminals, markers): (Vec<_>, Vec<_>) = self.terminals_with_markers().into_iter().unzip();
        markers_by_leaf(&terminals, &markers)
    }

    /// Tell every window that the set of terminals on an older host may have
    /// changed: one was registered on a host or forgotten.
    pub fn notify_terminal_generations(&self) {
        let _ = self.app_handle.emit(TERMINAL_GENERATIONS_EVENT, ());
    }
}

#[cfg(test)]
mod generation_tests;
