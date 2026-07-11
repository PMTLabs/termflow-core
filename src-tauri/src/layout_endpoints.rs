use axum::{
    extract::{State},
    response::{IntoResponse},
    Json,
    http::StatusCode,
};
use serde_json::{json, Value};
use crate::state::AppState;

pub async fn get_layout(
    State(state): State<AppState>,
) -> impl IntoResponse {
    match state.layout_manager.get_layout() {
        Some(layout) => (StatusCode::OK, Json(layout)),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "No layout found" }))),
    }
}

pub async fn save_layout(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    match state.layout_manager.save_layout(payload) {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "saved" }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))),
    }
}
