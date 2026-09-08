use axum::{extract::Path, http::StatusCode, response::IntoResponse, Json};
use serde_json::json;
use crate::pty_manager::{self, ShellProfile};

// Profile management endpoints

pub(crate) async fn list_profiles() -> impl IntoResponse {
    let profiles = pty_manager::get_available_shells();
    Json(json!({ "profiles": profiles }))
}

pub(crate) async fn get_profile_by_id(Path(id): Path<String>) -> impl IntoResponse {
    match pty_manager::get_profile(&id) {
        Some(profile) => (StatusCode::OK, Json(json!(profile))),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": "Profile not found" }))),
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct CreateProfileReq {
    name: String,
    path: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: std::collections::HashMap<String, String>,
    cwd: Option<String>,
    icon: Option<String>,
}

pub(crate) async fn create_profile(Json(payload): Json<CreateProfileReq>) -> impl IntoResponse {
    let profile = ShellProfile {
        id: String::new(), // Will be auto-generated
        name: payload.name,
        path: payload.path,
        args: payload.args,
        env: payload.env,
        cwd: payload.cwd,
        icon: payload.icon,
        is_default: false,
        is_custom: true,
    };
    
    match pty_manager::add_custom_profile(profile) {
        Ok(id) => (StatusCode::CREATED, Json(json!({ "id": id, "status": "created" }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))),
    }
}

pub(crate) async fn update_profile(
    Path(id): Path<String>,
    Json(payload): Json<CreateProfileReq>,
) -> impl IntoResponse {
    let profile = ShellProfile {
        id: id.clone(),
        name: payload.name,
        path: payload.path,
        args: payload.args,
        env: payload.env,
        cwd: payload.cwd,
        icon: payload.icon,
        is_default: false,
        is_custom: true,
    };
    
    match pty_manager::update_custom_profile(&id, profile) {
        Ok(()) => (StatusCode::OK, Json(json!({ "status": "updated" }))),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))),
    }
}

pub(crate) async fn delete_profile(Path(id): Path<String>) -> impl IntoResponse {
    match pty_manager::delete_custom_profile(&id) {
        Ok(()) => (StatusCode::OK, Json(json!({ "status": "deleted" }))),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "error": e }))),
    }
}

pub(crate) async fn set_default_profile(Path(_id): Path<String>) -> impl IntoResponse {
    // TODO: Implement set default profile
    Json(json!({ "status": "ok" }))
}


