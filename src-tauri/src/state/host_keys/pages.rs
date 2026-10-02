//! OS-window incarnations and renderer pages. This table shares the ownership
//! mutex so page endings can also release pane ownership in the same step.

use std::collections::{BTreeMap, HashMap};
use super::{HostKeys, Inner};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status")]
pub(crate) enum PageRegistration {
    Retry,
    Registered { wi: u64, pg: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PageIdentity {
    pub wi: u64,
    pub pg: u64,
}

#[derive(Default)]
pub(super) struct WindowPages {
    window_sequence: u64,
    page_sequence: u64,
    building: HashMap<String, u64>,
    committed: HashMap<String, u64>,
    pages: BTreeMap<u64, u64>,
}

impl WindowPages {
    fn reserve(&mut self, label: &str) -> Result<u64, String> {
        if self.building.contains_key(label) {
            return Err("window build already in progress".into());
        }
        let wi = self.window_sequence.checked_add(1).ok_or("window sequence exhausted")?;
        self.window_sequence = wi;
        self.building.insert(label.to_string(), wi);
        Ok(wi)
    }

    fn cancel(&mut self, label: &str, wi: u64) -> bool {
        if self.building.get(label) != Some(&wi) { return false; }
        self.building.remove(label);
        true
    }

    fn commit(&mut self, label: &str, wi: u64) -> Result<(), String> {
        if !self.cancel(label, wi) { return Err("window build ended before commit".into()); }
        self.committed.insert(label.to_string(), wi);
        Ok(())
    }

    fn register(&mut self, label: &str) -> Result<PageRegistration, String> {
        if self.building.contains_key(label) { return Ok(PageRegistration::Retry); }
        let Some(&wi) = self.committed.get(label) else { return Ok(PageRegistration::Retry) };
        let pg = self.page_sequence.checked_add(1).ok_or("page sequence exhausted")?;
        self.page_sequence = pg;
        self.pages.insert(pg, wi);
        Ok(PageRegistration::Registered { wi, pg })
    }

    fn end_matching(&mut self, wi: u64, below: Option<u64>) -> Vec<PageIdentity> {
        let ended: Vec<_> = self.pages.iter()
            .filter(|(pg, window)| **window == wi && below.is_none_or(|limit| **pg < limit))
            .map(|(pg, wi)| PageIdentity { wi: *wi, pg: *pg }).collect();
        for page in &ended { self.pages.remove(&page.pg); }
        ended
    }

    fn destroy(&mut self, label: &str, wi: u64) -> Vec<PageIdentity> {
        // A listener may execute after build returns but before it commits.
        self.cancel(label, wi);
        if self.committed.get(label) == Some(&wi) { self.committed.remove(label); }
        self.end_matching(wi, None)
    }

    fn settle(&mut self, page: PageIdentity) -> Result<Vec<PageIdentity>, String> {
        if self.pages.get(&page.pg) != Some(&page.wi) { return Err("page is no longer live".into()); }
        Ok(self.end_matching(page.wi, Some(page.pg)))
    }
}

pub(crate) struct WindowBuildGuard {
    keys: HostKeys,
    label: String,
    wi: u64,
}

impl WindowBuildGuard {
    pub(crate) fn identity(&self) -> (&str, u64) { (&self.label, self.wi) }
    pub(crate) fn keys(&self) -> HostKeys { self.keys.clone() }

    pub(crate) fn commit(self) -> Result<(), String> {
        self.keys.lock().window_pages.commit(&self.label, self.wi)
    }
}

impl Drop for WindowBuildGuard {
    fn drop(&mut self) { self.keys.lock().window_pages.cancel(&self.label, self.wi); }
}

impl HostKeys {
    pub(crate) fn reserve_window(&self, label: &str) -> Result<WindowBuildGuard, String> {
        let wi = self.lock().window_pages.reserve(label)?;
        Ok(WindowBuildGuard { keys: self.clone(), label: label.to_string(), wi })
    }

    pub(crate) fn register_page(&self, label: &str) -> Result<PageRegistration, String> {
        self.lock().window_pages.register(label)
    }

    pub(crate) fn destroy_window(&self, label: &str, wi: u64) -> Vec<PageIdentity> {
        let mut inner = self.lock();
        let ended = inner.window_pages.destroy(label, wi);
        Self::end_pages_locked(&mut inner, &ended);
        ended
    }

    /// Called by the ordered page stream after the new page has settled.
    #[allow(dead_code)] // The page stream is installed separately from window construction.
    pub(crate) fn settle_page(&self, page: crate::state::PageIdentity) -> Result<Vec<PageIdentity>, String> {
        let mut inner = self.lock();
        let ended = inner.window_pages.settle(page)?;
        Self::end_pages_locked(&mut inner, &ended);
        Ok(ended)
    }

    /// Page-end seam: pane owners, restore holders and taken transfers must be
    /// released here, while the same ownership mutex is still held.
    fn end_pages_locked(_inner: &mut Inner, _ended: &[PageIdentity]) {}
}

#[cfg(test)]
#[path = "page_tests.rs"]
mod tests;
