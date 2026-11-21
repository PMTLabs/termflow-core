//! Desktop-only metrics IPC. The renderer's pg is a claim; native window
//! identity and live-page/placement verification come from the authority.
use crate::ssh::{metrics::{sampler::Fence, watch::WatchRegistry}, session::SessionError};
use serde::Serialize;
use std::sync::Arc;
use tauri::{ipc::Request, Runtime, State, WebviewWindow};
use uuid::Uuid;

/// T4 passes the page-registration reply's `pg` in this invoke header.
pub const PAGE_HEADER: &str = "x-termflow-page";

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum MetricsError {
    Binding(BindingError),
    Session(SessionError),
}

#[derive(Debug, Serialize)]
#[serde(tag = "code", rename_all = "kebab-case")]
pub enum BindingError {
    InvalidPage,
    InvalidConsumer,
}

impl From<SessionError> for MetricsError {
    fn from(error: SessionError) -> Self { Self::Session(error) }
}

fn parse_page(headers: &tauri::http::HeaderMap) -> Result<u64, MetricsError> {
    let mut values = headers.get_all(PAGE_HEADER).iter();
    values.next().filter(|_| values.next().is_none())
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|pg| *pg != 0)
        .ok_or(MetricsError::Binding(BindingError::InvalidPage))
}

fn consumer_id(value: &str) -> Result<Uuid, MetricsError> {
    Uuid::parse_str(value).ok().filter(|id| !id.is_nil())
        .ok_or(MetricsError::Binding(BindingError::InvalidConsumer))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResumeReply {
    sample_floor: u64,
    generation: u64,
    pause_seq: u64,
}

#[tauri::command]
pub(crate) fn ssh_metrics_watch<R: Runtime>(
    window: WebviewWindow<R>, state: State<'_, Arc<WatchRegistry>>, request: Request<'_>,
    terminal_id: String, consumer_id: String,
) -> Result<Fence, MetricsError> {
    Ok(state.watch(window.label(), parse_page(request.headers())?, &terminal_id, self::consumer_id(&consumer_id)?)?)
}

#[tauri::command]
pub(crate) fn ssh_metrics_unwatch<R: Runtime>(
    window: WebviewWindow<R>, state: State<'_, Arc<WatchRegistry>>, request: Request<'_>,
    terminal_id: String, consumer_id: String,
) -> Result<(), MetricsError> {
    Ok(state.unwatch(window.label(), parse_page(request.headers())?, &terminal_id, self::consumer_id(&consumer_id)?)?)
}

#[tauri::command]
pub(crate) fn ssh_metrics_resume<R: Runtime>(
    window: WebviewWindow<R>, state: State<'_, Arc<WatchRegistry>>, request: Request<'_>,
    terminal_id: String, consumer_id: String,
) -> Result<ResumeReply, MetricsError> {
    let Fence { sample_floor, generation, pause_seq, .. } =
        state.resume(window.label(), parse_page(request.headers())?, &terminal_id, self::consumer_id(&consumer_id)?)?;
    Ok(ResumeReply { sample_floor, generation, pause_seq })
}

#[cfg(all(test, feature = "integration-tests", not(windows)))]
mod invoke_tests;
