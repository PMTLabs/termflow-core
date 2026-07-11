use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
    http::{StatusCode, header},
};
use serde_json::json;
use crate::state::AppState;
use crate::recording_service::{RecordingOptions, TerminalSize};

#[derive(serde::Deserialize)]
pub struct StartRecordingReq {
    terminal_id: String,
    #[serde(default)]
    options: Option<RecordingOptions>,
}

#[derive(serde::Deserialize)]
pub struct ExportReq {
    format: String, // json, text, html, asciinema
    #[serde(default)]
    _include_metadata: bool,
    #[serde(default)]
    _include_timestamps: bool,
}

pub async fn start_recording(
    State(state): State<AppState>,
    Json(payload): Json<StartRecordingReq>,
) -> impl IntoResponse {
    let terminal_id = payload.terminal_id;
    let options = payload.options.unwrap_or_default();
    
    // Check if terminal exists to get metadata
    let (initial_size, shell_type) = if let Some(term) = state.terminals.get(&terminal_id) {
        (TerminalSize { cols: term.cols, rows: term.rows }, Some(term.shell.clone()))
    } else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Terminal not found" })));
    };
    
    match state.recording_service.start_recording(&terminal_id, options, initial_size, shell_type) {
        Ok(id) => (StatusCode::CREATED, Json(json!({ 
            "recordingId": id,
            "terminalId": terminal_id,
            "status": "recording" 
        }))),
        Err(e) => (StatusCode::CONFLICT, Json(json!({ "error": e }))),
    }
}

pub async fn stop_recording(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.recording_service.stop_recording(&id) {
        Ok(recording) => (StatusCode::OK, Json(json!({ 
            "recordingId": recording.id,
            "status": "stopped",
            "size": recording.size,
            "eventCount": recording.events.len()
        }))),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))),
    }
}

pub async fn list_recordings(
    State(state): State<AppState>,
) -> impl IntoResponse {
    match state.recording_service.list_recordings() {
        Ok(recordings) => {
            // Return simplified list
            let list: Vec<_> = recordings.iter().map(|r| json!({
                "id": r.id,
                "terminalId": r.terminal_id,
                "startTime": r.start_time.to_rfc3339(),
                "endTime": r.end_time.map(|t| t.to_rfc3339()),
                "size": r.size,
                "eventCount": r.events.len()
            })).collect();
            (StatusCode::OK, Json(json!({ "recordings": list })))
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))),
    }
}

pub async fn get_recording(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.recording_service.load_recording(&id) {
        Ok(recording) => (StatusCode::OK, Json(json!(recording))),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))),
    }
}

pub async fn get_recording_info(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.recording_service.get_recording_info(&id) {
        Ok(info) => (StatusCode::OK, Json(info)),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))),
    }
}

pub async fn delete_recording(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.recording_service.delete_recording(&id) {
        Ok(_) => (StatusCode::NO_CONTENT, Json(serde_json::Value::Null)),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))),
    }
}

pub async fn export_recording(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<ExportReq>,
) -> impl IntoResponse {
    let result = match payload.format.as_str() {
        "json" => state.recording_service.export_as_json(&id),
        "text" => state.recording_service.export_as_text(&id),
        "html" => state.recording_service.export_as_html(&id),
        "asciinema" => state.recording_service.export_as_asciinema(&id),
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Unsupported format" }))).into_response(),
    };
    
    match result {
        Ok(content) => {
            let content_type = match payload.format.as_str() {
                "json" | "asciinema" => "application/json",
                "html" => "text/html",
                "text" => "text/plain",
                _ => "application/octet-stream",
            };
            
            let filename = format!("recording-{}.{}", id, match payload.format.as_str() {
                "asciinema" => "cast",
                f => f
            });

            ([(header::CONTENT_TYPE, content_type), (header::CONTENT_DISPOSITION, &format!("attachment; filename=\"{}\"", filename))], content).into_response()
        },
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))).into_response(),
    }
}

pub async fn get_recording_status(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
) -> impl IntoResponse {
    let is_recording = state.recording_service.is_recording(&terminal_id);
    (StatusCode::OK, Json(json!({
        "terminalId": terminal_id,
        "isRecording": is_recording,
        "status": if is_recording { "recording" } else { "not_recording" }
    })))
}

pub async fn get_active_recordings(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let active = state.recording_service.get_active_recordings();
    (StatusCode::OK, Json(json!({ "activeRecordings": active, "count": active.len() })))
}
