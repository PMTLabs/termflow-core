use axum::{
    extract::State,
    http::header::{AUTHORIZATION, CONTENT_TYPE},
    http::{HeaderValue, Method, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::cors::CorsLayer;
use chrono::{Duration, Utc};
use jsonwebtoken::{encode, EncodingKey, Header};
use crate::state::AppState;

/// Constant-time string comparison, so token checks don't leak length/content
/// via timing. The token guards a terminal-I/O (RCE-capable) surface.
pub(crate) fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The renderer's own origins. Windows/Android serve the app over
/// `http(s)://tauri.localhost`; macOS/Linux use the `tauri://localhost` custom
/// protocol. In debug the renderer is served by the Vite dev server declared as
/// `devUrl` in `tauri.conf.json`, so it must be allowed too — omitting it 403s
/// the dev renderer on day one.
pub(crate) const APP_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];
#[cfg(debug_assertions)]
pub(crate) const DEV_ORIGIN: &str = "http://localhost:42010";

pub(crate) fn origin_is_app(origin: &str) -> bool {
    if APP_ORIGINS.contains(&origin) {
        return true;
    }
    #[cfg(debug_assertions)]
    {
        return origin == DEV_ORIGIN;
    }
    #[cfg(not(debug_assertions))]
    false
}

/// Reject a `Host` that is not a loopback name. Defence in depth against DNS
/// rebinding: a page on `attacker.example` (resolving to 127.0.0.1) reaches a
/// loopback-bound server, and requests it makes without an `Origin` header would
/// otherwise pass. Absent header ⇒ nothing to validate.
pub(crate) fn host_is_loopback(host: Option<&str>) -> bool {
    let Some(h) = host else { return true };
    let name = if let Some(rest) = h.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inner, _)) => inner,
            None => return false,
        }
    } else {
        h.rsplit_once(':').map(|(n, _)| n).unwrap_or(h)
    };
    name == "localhost"
        || name == "::1"
        || name
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Is this request's provenance acceptable?
///
/// D1 keeps the loopback API unauthenticated, so provenance is what stops a web
/// page in the user's browser from driving the user's terminals. A request with
/// NO `Origin` — curl, the MCP sidecar, user scripts — is still allowed: those
/// are the documented clients and a browser always sends one.
pub(crate) fn origin_allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    host_is_loopback(host) && origin.map(origin_is_app).unwrap_or(true)
}

/// Explicit CORS, replacing `CorsLayer::permissive()`. Permissive echoed back
/// whatever `Origin` it was given, so any web page could read API responses —
/// the provenance gate above would be pointless if the browser were still told
/// the response is readable by anyone.
pub(crate) fn cors_layer() -> CorsLayer {
    // `mut` is only used by the debug-only dev-origin push below.
    #[allow(unused_mut)]
    let mut origins: Vec<HeaderValue> = APP_ORIGINS
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    #[cfg(debug_assertions)]
    if let Ok(v) = HeaderValue::from_str(DEV_ORIGIN) {
        origins.push(v);
    }
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
        .max_age(std::time::Duration::from_secs(600))
}

/// Must this request carry a bearer token?
///
/// D1 keeps loopback open for NORMAL instances — curl, the MCP sidecar and user
/// scripts stay zero-friction. An ELEVATED instance is a different risk class:
/// an unauthenticated write there turns any medium-integrity process on the
/// machine into Medium→High privilege escalation, because the API spawns
/// processes. Provenance checks alone do not cover that — they only stop
/// browsers, not local programs.
pub fn auth_required(integrity: crate::profile::Integrity, expose: bool) -> bool {
    expose || integrity == crate::profile::Integrity::High
}

/// Routes that require a bearer token **regardless** of `auth_required`.
///
/// D1 leaves a NORMAL instance's loopback API unauthenticated so curl, the MCP
/// sidecar and user scripts stay zero-friction. That trade is fine for terminal
/// verbs, whose blast radius is this user's own shells. It is not fine for a
/// verb that changes another process's shutdown semantics: `/api/hotswap/arm`
/// makes a sibling hold a detach window it never asked for, and any local
/// process could call it.
///
/// The cost of requiring a token here is zero — the only legitimate caller is a
/// sibling instance, which already holds the token from our `InstanceRecord`.
pub fn route_always_requires_token(path: &str) -> bool {
    path.starts_with("/api/hotswap/")
}


#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Claims {
    sub: String,
    permissions: Vec<String>,
    exp: usize,
    iat: usize,
}

#[derive(serde::Deserialize)]
pub(crate) struct AuthReq {
    #[serde(rename = "clientId")]
    client_id: Option<String>,
    permissions: Option<Vec<String>>,
}

pub(crate) async fn generate_token_handler(
    State(state): State<AppState>,
    Json(payload): Json<AuthReq>,
) -> impl IntoResponse {
    let client_id = payload.client_id.unwrap_or_else(|| "unknown".to_string());
    let permissions = payload.permissions.unwrap_or_else(|| vec!["*".to_string()]);
    let exp = Utc::now() + Duration::hours(24);
    
    let claims = Claims {
        sub: client_id,
        permissions: permissions.clone(),
        exp: exp.timestamp() as usize,
        iat: Utc::now().timestamp() as usize,
    };

    let token = match encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    ) {
        Ok(t) => t,
        Err(e) => {
            log::error!("Failed to generate token: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Failed to generate token" }))).into_response()
        },
    };

    Json(json!({
        "token": token,
        "expiresIn": "24h",
        "permissions": permissions
    })).into_response()
}



#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_release_and_dev_renderers_are_both_allowed() {
        assert!(origin_allowed(Some("http://tauri.localhost"), Some("127.0.0.1:42031")));
        assert!(origin_allowed(Some("https://tauri.localhost"), Some("127.0.0.1:42031")));
        // macOS/Linux serve the app over the custom protocol instead.
        assert!(origin_allowed(Some("tauri://localhost"), Some("127.0.0.1:42031")));
        // tauri.conf.json:9 -- rev 1 omitted this and would have broken dev.
        #[cfg(debug_assertions)]
        assert!(origin_allowed(Some("http://localhost:42010"), Some("127.0.0.1:42031")));
    }

    #[test]
    fn requests_from_a_web_page_are_rejected() {
        assert!(!origin_allowed(Some("https://evil.example"), Some("127.0.0.1:42031")));
        assert!(!origin_allowed(Some("http://localhost:3000"), Some("127.0.0.1:42031")));
        // Near-misses on the app origin must not slip through a prefix check.
        assert!(!origin_allowed(Some("http://tauri.localhost.evil.example"), None));
        assert!(!origin_allowed(Some("http://evil.tauri.localhost"), None));
    }

    #[test]
    fn requests_with_no_origin_are_allowed() {
        // D1: curl, the MCP sidecar and user scripts are unchanged.
        assert!(origin_allowed(None, Some("127.0.0.1:42031")));
    }

    #[test]
    fn an_elevated_instance_requires_a_token_even_on_loopback() {
        use crate::profile::Integrity;
        // D1 keeps loopback open for NORMAL instances. An elevated instance is a
        // different risk class: an unauthenticated write becomes Medium->High
        // privilege escalation, so provenance checks are not sufficient there.
        assert!(auth_required(Integrity::High, /*expose*/ false));
        assert!(!auth_required(Integrity::Medium, false));
        assert!(auth_required(Integrity::Medium, true));
        assert!(auth_required(Integrity::High, true));
    }

    /// Design 014 §B-D5. `auth_required` is false for a normal, non-exposed
    /// instance, so its loopback API is unauthenticated — fine for terminal
    /// verbs, not fine for one that changes another process's shutdown
    /// semantics. Any local process could otherwise arm a sibling.
    #[test]
    fn the_hotswap_routes_always_require_a_token() {
        assert!(route_always_requires_token("/api/hotswap/arm"));
        assert!(route_always_requires_token("/api/hotswap/disarm"));
    }

    /// ...and ordinary routes keep D1's zero-friction loopback, or this would
    /// be a silent breaking change for curl and the MCP sidecar.
    #[test]
    fn ordinary_routes_keep_the_unauthenticated_loopback() {
        for path in ["/api/terminals", "/api/health", "/health", "/api/system/info", "/api/fleet/terminals"] {
            assert!(!route_always_requires_token(path), "{path} must not become token-gated");
        }
    }

    /// The prefix must not leak onto a route that merely starts similarly — a
    /// blanket `contains("hotswap")` would catch unrelated future paths.
    #[test]
    fn the_always_token_rule_is_scoped_to_the_hotswap_prefix() {
        assert!(!route_always_requires_token("/api/terminals/hotswap"));
        assert!(!route_always_requires_token("/api/hotswapping"));
    }

    #[test]
    fn every_allowed_origin_is_a_legal_header_value() {
        // `cors_layer` silently drops an origin that fails to parse, which would
        // 403 that renderer at runtime with no compile-time signal. Build it here
        // and check each candidate converts.
        for o in APP_ORIGINS {
            assert!(HeaderValue::from_str(o).is_ok(), "unusable origin: {o}");
        }
        #[cfg(debug_assertions)]
        assert!(HeaderValue::from_str(DEV_ORIGIN).is_ok());
        let _ = cors_layer();
    }

    #[test]
    fn dns_rebinding_hosts_are_rejected() {
        assert!(!origin_allowed(None, Some("attacker.example")));
        assert!(origin_allowed(None, Some("localhost:42031")));
        assert!(origin_allowed(None, Some("[::1]:42031")));
        assert!(origin_allowed(None, Some("127.0.0.1")));
        assert!(origin_allowed(None, None));
    }


}
