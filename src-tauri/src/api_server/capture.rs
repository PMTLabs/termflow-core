use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use crate::state::AppState;
use crate::tmux_manager::{self, CapturedContent, TerminalBackend};
use super::terminals::{render_terminal_history, terminal_size_for_output};

// Test capture start/stop endpoints

#[derive(Deserialize)]
pub(crate) struct StartTestPayload {
    #[serde(rename = "testId")]
    test_id: String,
}

pub(crate) async fn start_test_capture(
    State(state): State<AppState>,
    Json(payload): Json<StartTestPayload>,
) -> impl IntoResponse {
    // Create test-captures directory
    let dir = &state.test_capture_dir;
    if let Err(e) = fs::create_dir_all(dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("Failed to create directory: {}", e) }))
        );
    }

    // Set test ID and enable capture
    *state.test_capture_id.write() = Some(payload.test_id.clone());
    state.test_capture_enabled.store(true, std::sync::atomic::Ordering::SeqCst);

    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "testId": payload.test_id,
            "message": "Test capture started"
        }))
    )
}

pub(crate) async fn stop_test_capture(
    State(state): State<AppState>,
) -> impl IntoResponse {
    state.test_capture_enabled.store(false, std::sync::atomic::Ordering::SeqCst);
    let test_id = state.test_capture_id.write().take();

    Json(json!({
        "success": true,
        "testId": test_id,
        "message": "Test capture stopped"
    }))
}

// Test capture payload structs

#[derive(Deserialize)]
pub(crate) struct CapturePayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    #[serde(rename = "testId")]
    test_id: String,
    data: String,
}

#[derive(Deserialize)]
pub(crate) struct CaptureFrontendPayload {
    #[serde(rename = "terminalId")]
    terminal_id: String,
    #[serde(rename = "testId")]
    test_id: String,
    data: String,
    metadata: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub(crate) struct CompareResult {
    #[serde(rename = "match")]
    is_match: bool,
    #[serde(rename = "backendSize")]
    backend_size: usize,
    #[serde(rename = "frontendSize")]
    frontend_size: usize,
    #[serde(rename = "backendExists")]
    backend_exists: bool,
    #[serde(rename = "frontendExists")]
    frontend_exists: bool,
    diff_summary: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct CaptureFile {
    filename: String,
    #[serde(rename = "testId")]
    test_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    source: String, // "backend" or "frontend"
    size: u64,
}

// Test capture endpoint handlers

pub(crate) async fn capture_backend(
    State(state): State<AppState>,
    Json(payload): Json<CapturePayload>,
) -> impl IntoResponse {
    let dir = &state.test_capture_dir;

    if let Err(e) = fs::create_dir_all(dir) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("Failed to create directory: {}", e)
        })));
    }

    let filename = format!("backend-{}-{}.txt", payload.test_id, payload.terminal_id);
    let filepath = dir.join(&filename);

    match fs::write(&filepath, &payload.data) {
        Ok(_) => (StatusCode::OK, Json(json!({
            "status": "ok",
            "filename": filename,
            "size": payload.data.len()
        }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("Failed to write file: {}", e)
        }))),
    }
}

pub(crate) async fn capture_frontend(
    State(state): State<AppState>,
    Json(payload): Json<CaptureFrontendPayload>,
) -> impl IntoResponse {
    let dir = &state.test_capture_dir;

    if let Err(e) = fs::create_dir_all(dir) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("Failed to create directory: {}", e)
        })));
    }

    let filename = format!("frontend-{}-{}.txt", payload.test_id, payload.terminal_id);
    let filepath = dir.join(&filename);

    match fs::write(&filepath, &payload.data) {
        Ok(_) => {
            // Also write metadata if present
            if let Some(metadata) = &payload.metadata {
                let meta_filename = format!("frontend-{}-{}.meta.json", payload.test_id, payload.terminal_id);
                let meta_filepath = dir.join(&meta_filename);
                let _ = fs::write(&meta_filepath, serde_json::to_string_pretty(metadata).unwrap_or_default());
            }

            (StatusCode::OK, Json(json!({
                "status": "ok",
                "filename": filename,
                "size": payload.data.len()
            })))
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": format!("Failed to write file: {}", e)
        }))),
    }
}

pub(crate) async fn compare_captures(
    State(state): State<AppState>,
    Path((test_id, terminal_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let dir = &state.test_capture_dir;

    let backend_filename = format!("backend-{}-{}.txt", test_id, terminal_id);
    let frontend_filename = format!("frontend-{}-{}.txt", test_id, terminal_id);

    let backend_path = dir.join(&backend_filename);
    let frontend_path = dir.join(&frontend_filename);

    let backend_exists = backend_path.exists();
    let frontend_exists = frontend_path.exists();

    let backend_content = if backend_exists {
        fs::read_to_string(&backend_path).unwrap_or_default()
    } else {
        String::new()
    };

    let frontend_content = if frontend_exists {
        fs::read_to_string(&frontend_path).unwrap_or_default()
    } else {
        String::new()
    };

    let backend_size = backend_content.len();
    let frontend_size = frontend_content.len();
    let is_match = backend_exists && frontend_exists && backend_content == frontend_content;

    // Generate diff summary if both exist and don't match
    let diff_summary = if backend_exists && frontend_exists && !is_match {
        let backend_lines: Vec<&str> = backend_content.lines().collect();
        let frontend_lines: Vec<&str> = frontend_content.lines().collect();

        let mut diffs = Vec::new();
        let max_lines = backend_lines.len().max(frontend_lines.len());
        let mut diff_count = 0;

        for i in 0..max_lines {
            let b_line = backend_lines.get(i);
            let f_line = frontend_lines.get(i);

            if b_line != f_line {
                diff_count += 1;
                if diffs.len() < 10 { // Limit to first 10 diffs
                    diffs.push(format!(
                        "Line {}: backend={:?}, frontend={:?}",
                        i + 1,
                        b_line.unwrap_or(&"<missing>"),
                        f_line.unwrap_or(&"<missing>")
                    ));
                }
            }
        }

        if diff_count > 10 {
            diffs.push(format!("... and {} more differences", diff_count - 10));
        }

        Some(format!(
            "Total lines: backend={}, frontend={}. Differences: {}",
            backend_lines.len(),
            frontend_lines.len(),
            diffs.join("\n")
        ))
    } else {
        None
    };

    let result = CompareResult {
        is_match,
        backend_size,
        frontend_size,
        backend_exists,
        frontend_exists,
        diff_summary,
    };

    (StatusCode::OK, Json(result))
}

pub(crate) async fn list_captures(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let dir = &state.test_capture_dir;

    if !dir.exists() {
        return (StatusCode::OK, Json(json!({ "captures": [], "count": 0 })));
    }

    let mut captures: Vec<CaptureFile> = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                // Skip metadata files
                if filename.ends_with(".meta.json") {
                    continue;
                }

                // Parse filename: backend-{testId}-{terminalId}.txt or frontend-{testId}-{terminalId}.txt
                if filename.ends_with(".txt") {
                    let parts: Vec<&str> = filename.trim_end_matches(".txt").splitn(3, '-').collect();
                    if parts.len() == 3 {
                        let source = parts[0].to_string();
                        let test_id = parts[1].to_string();
                        let terminal_id = parts[2].to_string();
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

                        captures.push(CaptureFile {
                            filename: filename.to_string(),
                            test_id,
                            terminal_id,
                            source,
                            size,
                        });
                    }
                }
            }
        }
    }

    let count = captures.len();
    (StatusCode::OK, Json(json!({ "captures": captures, "count": count })))
}

// ============================================================================
// tmux Reflow-Aware Endpoints
// ============================================================================

#[derive(Deserialize)]
pub(crate) struct ResizeReflowReq {
    cols: u16,
    rows: u16,
    capture_content: Option<bool>,
}

#[derive(Serialize)]
pub(crate) struct ResizeReflowResponse {
    status: String,
    cols: u16,
    rows: u16,
    content: Option<CapturedContent>,
    reflow_applied: bool,
}

/// Resize terminal with content reflow support.
///
/// For tmux backends, this resizes the session and captures the reflowed content.
/// For portable-pty backends, this falls back to standard resize (no reflow).
pub(crate) async fn resize_with_reflow(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ResizeReflowReq>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    log::info!("Resize-reflow request for terminal {}: {}x{}", id, payload.cols, payload.rows);

    // Check if terminal exists and get its backend type
    let backend = match state.get_terminal_backend(&id) {
        Some(b) => b,
        None => {
            log::warn!("Terminal {} not found for resize-reflow", id);
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response();
        }
    };

    match backend {
        TerminalBackend::TmuxNative | TerminalBackend::TmuxWsl => {
            // tmux backend: resize session and capture reflowed content
            if let Some(session_mutex) = state.tmux_sessions.get(&id) {
                let session = match session_mutex.lock() {
                    Ok(s) => s,
                    Err(_) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "tmux session mutex poisoned" }))).into_response();
                    }
                };
                let config = state.tmux_config.read();

                match tmux_manager::resize_session(&session, &config, payload.cols, payload.rows) {
                    Ok(captured) => {
                        if let Some(mut terminal) = state.terminals.get_mut(&id) {
                            terminal.cols = payload.cols;
                            terminal.rows = payload.rows;
                        }
                        log::info!("Terminal {} resized with reflow to {}x{}", id, payload.cols, payload.rows);
                        let response = ResizeReflowResponse {
                            status: "ok".to_string(),
                            cols: payload.cols,
                            rows: payload.rows,
                            content: if payload.capture_content.unwrap_or(true) { Some(captured) } else { None },
                            reflow_applied: true,
                        };
                        (StatusCode::OK, Json(serde_json::to_value(response).unwrap())).into_response()
                    }
                    Err(e) => {
                        log::error!("Failed to resize tmux session {}: {}", id, e);
                        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response()
                    }
                }
            } else {
                log::warn!("tmux session {} not found", id);
                (StatusCode::NOT_FOUND, Json(json!({ "error": "tmux session not found" }))).into_response()
            }
        }
        TerminalBackend::PortablePty => {
            // Host-owned terminals resize via the sidecar (no local master).
            if state.host_resize(&id, payload.cols, payload.rows) {
                if let Some(mut terminal) = state.terminals.get_mut(&id) {
                    terminal.cols = payload.cols;
                    terminal.rows = payload.rows;
                }
                state.resize_screen(&id, payload.rows, payload.cols);
                return Json(json!({ "status": "ok", "cols": payload.cols, "rows": payload.rows })).into_response();
            }
            // Portable-pty backend: standard resize without reflow
            if let Some(master_mutex) = state.ptys.get(&id) {
                let master = match master_mutex.lock() {
                    Ok(m) => m,
                    Err(_) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "terminal pty mutex poisoned" }))).into_response();
                    }
                };
                let new_size = portable_pty::PtySize {
                    rows: payload.rows,
                    cols: payload.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                };

                match master.resize(new_size) {
                    Ok(_) => {
                        if let Some(mut terminal) = state.terminals.get_mut(&id) {
                            terminal.cols = payload.cols;
                            terminal.rows = payload.rows;
                        }
                        // Keep the authoritative screen parser in sync so later
                        // snapshots reflect this size (the other resize paths do too).
                        state.resize_screen(&id, payload.rows, payload.cols);
                        log::info!("Terminal {} resized (no reflow) to {}x{}", id, payload.cols, payload.rows);
                        let response = ResizeReflowResponse {
                            status: "ok".to_string(),
                            cols: payload.cols,
                            rows: payload.rows,
                            content: None,
                            reflow_applied: false,
                        };
                        (StatusCode::OK, Json(serde_json::to_value(response).unwrap())).into_response()
                    }
                    Err(e) => {
                        log::error!("Failed to resize terminal {}: {}", id, e);
                        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response()
                    }
                }
            } else {
                log::warn!("PTY {} not found for resize", id);
                (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response()
            }
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct CapturePaneQuery {
    include_scrollback: Option<bool>,
}

/// Capture terminal content.
///
/// For tmux backends, this captures the pane content with optional scrollback.
/// For portable-pty backends, this returns the history buffer.
pub(crate) async fn capture_terminal_content(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(query): axum::extract::Query<CapturePaneQuery>,
) -> impl IntoResponse {
    // Normalise the caller-supplied reference to this run's map key. The API
    // reports the DURABLE tm- leaf as `terminalId`, but the per-terminal maps
    // are keyed by the per-run pc- id (design 014 A3). Without this, the
    // documented round trip - read `terminalId`, then address it - 404s.
    let id = state.resolve_ref(&id);
    log::info!("Capture content request for terminal {}", id);

    let backend = match state.get_terminal_backend(&id) {
        Some(b) => b,
        None => {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" }))).into_response();
        }
    };

    match backend {
        TerminalBackend::TmuxNative | TerminalBackend::TmuxWsl => {
            // tmux backend: use capture-pane
            if let Some(session_mutex) = state.tmux_sessions.get(&id) {
                let session = match session_mutex.lock() {
                    Ok(s) => s,
                    Err(_) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "tmux session mutex poisoned" }))).into_response();
                    }
                };
                let config = state.tmux_config.read();
                let include_scrollback = query.include_scrollback.unwrap_or(false);

                match tmux_manager::capture_content(&session, &config, include_scrollback) {
                    Ok(captured) => {
                        (StatusCode::OK, Json(serde_json::to_value(captured).unwrap())).into_response()
                    }
                    Err(e) => {
                        log::error!("Failed to capture tmux content for {}: {}", id, e);
                        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response()
                    }
                }
            } else {
                (StatusCode::NOT_FOUND, Json(json!({ "error": "tmux session not found" }))).into_response()
            }
        }
        TerminalBackend::PortablePty => {
            // Portable-pty backend: return history buffer.
            // Clone the chunks under a brief inner lock, then render with NO
            // locks held (see get_terminal_output — rendering under the history
            // lock starved the PTY output consumer).
            let chunks = state
                .get_history(&id)
                .map(|h| h.lock().unwrap_or_else(|p| p.into_inner()).clone());
            if let Some(history) = chunks {
                {
                    let (rows, cols) = terminal_size_for_output(&state, &id);
                    let content = render_terminal_history(&history, rows, cols);
                    let line_count = content.lines().count();

                    let captured = CapturedContent {
                        content,
                        line_count,
                        includes_scrollback: query.include_scrollback.unwrap_or(false),
                        cursor_position: None, // Not available for portable-pty
                    };
                    (StatusCode::OK, Json(serde_json::to_value(captured).unwrap())).into_response()
                }
            } else {
                // Return empty content if no history
                let captured = CapturedContent {
                    content: String::new(),
                    line_count: 0,
                    includes_scrollback: false,
                    cursor_position: None,
                };
                (StatusCode::OK, Json(serde_json::to_value(captured).unwrap())).into_response()
            }
        }
    }
}

#[derive(Serialize)]
pub(crate) struct TmuxStatusResponse {
    available: bool,
    tmux_path: String,
    wsl_distro: Option<String>,
    active_sessions: usize,
}

/// Get tmux availability status.
pub(crate) async fn get_tmux_status(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let config = state.tmux_config.read();
    let active_sessions = state.tmux_sessions.len();

    let response = TmuxStatusResponse {
        available: config.available,
        tmux_path: config.tmux_path.clone(),
        wsl_distro: config.wsl_distro.clone(),
        active_sessions,
    };

    Json(serde_json::to_value(response).unwrap())
}


