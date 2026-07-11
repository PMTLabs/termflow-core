use axum::{
    extract::{State, Query},
    response::IntoResponse,
    Json,
    http::StatusCode,
};
use serde_json::json;
use crate::state::AppState;
use crate::search_service::SearchQuery;
use std::collections::HashMap;

#[derive(serde::Deserialize)]
pub struct SearchReq {
    query: String,
    #[serde(default)]
    filters: HashMap<String, String>,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    50
}

pub async fn search(
    State(state): State<AppState>,
    Json(payload): Json<SearchReq>,
) -> impl IntoResponse {
    let query = SearchQuery {
        query: payload.query,
        filters: payload.filters,
        limit: payload.limit,
    };
    
    let results = state.search_service.search(query);
    
    // Transform match context for frontend
    let mapped_results: Vec<_> = results.into_iter().map(|m| json!({
        "document": {
            "id": m.document.id,
            "terminalId": m.document.terminal_id,
            "type": m.document.doc_type,
            "timestamp": m.document.timestamp.to_rfc3339()
        },
        "score": m.score,
        "matches": m.matches,
        "context": m.context
    })).collect();
    
    (StatusCode::OK, Json(json!({ "results": mapped_results })))
}

#[derive(serde::Deserialize)]
pub struct SuggestionsReq {
    q: String,
}

pub async fn get_suggestions(
    State(state): State<AppState>,
    Query(params): Query<SuggestionsReq>,
) -> impl IntoResponse {
    let suggestions = state.search_service.get_suggestions(&params.q);
    (StatusCode::OK, Json(json!({ "suggestions": suggestions })))
}

pub async fn clear_index(
    State(state): State<AppState>,
) -> impl IntoResponse {
    match state.search_service.clear_index() {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "cleared" }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))),
    }
}

pub async fn get_search_history() -> impl IntoResponse {
    // TODO: Implement search history
    (StatusCode::OK, Json(json!({ "history": [] })))
}
