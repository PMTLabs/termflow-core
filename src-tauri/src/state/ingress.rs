//! Ingress resolves durable pane references once. Deferred work keeps the process
//! reference, and the effect boundary checks that original shell again.

use super::{HostKeys, CloseStorage, CloseAction};
use super::types::{Terminal, retarget_owning_tab, set_display_label, set_title_color};
use dashmap::DashMap;

pub(crate) fn registered_target(keys: &HostKeys, reference: &str) -> Option<String> {
    keys.resolve_process(reference, false)
}

pub(crate) fn metadata_target(keys: &HostKeys, reference: &str) -> Result<Option<String>, String> {
    if reference.trim().is_empty() { return Err("a renderer terminal (leaf) id is required".into()); }
    let target = keys.resolve_process(reference.trim(), true);
    if target.is_none() && reference.starts_with("pc-") { return Err("Terminal not found".into()); }
    Ok(target)
}

pub(crate) fn close_target(keys: &HostKeys, reference: &str) -> Option<String> {
    keys.resolve_process(reference, true)
}

pub(crate) fn close(keys: &HostKeys, process: &str, policy: CloseStorage, end: impl FnOnce(&str)) -> bool {
    match keys.close_process(process, policy) {
        CloseAction::Cancelled => true,
        CloseAction::End { process, .. } => { end(&process); true }
        CloseAction::Missing => false,
    }
}

pub(crate) enum Metadata<'a> { OwningTab(&'a str), Label(Option<&'a str>), Color(Option<&'a str>) }

pub(crate) fn metadata(keys: &HostKeys, terminals: &DashMap<String, Terminal>, process: &str, change: Metadata<'_>) -> Result<bool, String> {
    keys.with_metadata(process, |process| match change {
        Metadata::OwningTab(tab) => retarget_owning_tab(terminals, process, tab),
        Metadata::Label(label) => set_display_label(terminals, process, label),
        Metadata::Color(color) => set_title_color(terminals, process, color),
    }).unwrap_or(Ok(false))
}
