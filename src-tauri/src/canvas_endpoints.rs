use crate::canvas_store::{CanvasEdge, InsertOutcome};
use crate::state::AppState;
use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};

/// What one renderer window publishes about its current canvas model. Revisions
/// are monotonic within a window; there is deliberately no cross-window ordering.
#[derive(Debug, Clone, Default)]
pub struct WindowRegistry {
    pub revision: u64,
    pub nodes: HashMap<String, NodeInfo>,
}

/// What the renderer publishes about each node. `node_id` is always the renderer
/// leaf (`tb-*`/`tm-*`), not the owning tab.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub node_id: String,
    pub title: Option<String>,
    pub group_id: Option<String>,
    pub group_title: Option<String>,
}

/// The only two origins accepted at the HTTP boundary. Keeping this as a serde
/// enum prevents arbitrary external input reaching the renderer's asserted union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeOrigin {
    User,
    Agent,
}

impl EdgeOrigin {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "agent" => Some(Self::Agent),
            _ => None,
        }
    }
}

/// A neighbour's direction relative to the terminal that asked for connections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionDirection {
    Outgoing,
    Incoming,
}

/// One neighbour, as seen from the asking node.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub node_id: String,
    /// Explicit null when this node is not currently published by any window.
    pub title: Option<String>,
    pub group_id: Option<String>,
    pub group_title: Option<String>,
    pub direction: ConnectionDirection,
    pub origin: EdgeOrigin,
    pub label: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupInfo {
    group_id: String,
    group_title: Option<String>,
}

#[derive(Debug, Serialize)]
struct CanvasGraph {
    version: u8,
    nodes: Vec<NodeInfo>,
    groups: Vec<GroupInfo>,
    edges: Vec<CanvasEdge>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEdgeReq {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    /// Defaults to `user` when omitted, but rejects every other value.
    pub origin: Option<EdgeOrigin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchEdgeReq {
    /// `null` (or an omitted field) clears the label.
    pub label: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutNodesReq {
    pub window_id: String,
    pub revision: u64,
    pub nodes: Vec<NodeInfo>,
}

/// Hide edges whose endpoints are gone without deleting their persisted rows.
pub fn filter_live(edges: Vec<CanvasEdge>, live: &HashSet<String>) -> Vec<CanvasEdge> {
    edges
        .into_iter()
        .filter(|edge| live.contains(&edge.from_id) && live.contains(&edge.to_id))
        .collect()
}

pub fn to_connections(
    node_id: &str,
    edges: Vec<CanvasEdge>,
    registry: &HashMap<String, NodeInfo>,
) -> Vec<Connection> {
    edges
        .into_iter()
        .filter_map(|edge| {
            let (other, direction) = if edge.from_id == node_id && edge.to_id != node_id {
                (edge.to_id.clone(), ConnectionDirection::Outgoing)
            } else if edge.to_id == node_id && edge.from_id != node_id {
                (edge.from_id.clone(), ConnectionDirection::Incoming)
            } else {
                return None; // Unrelated or self-edge (which would otherwise appear twice).
            };
            let origin = EdgeOrigin::parse(&edge.origin).unwrap_or_else(|| {
                // Existing rows predate (or bypassed) the HTTP enum boundary.
                // Preserve the connection, because losing a neighbour is worse
                // than conservatively classifying its unknown origin as user.
                log::warn!(
                    "[CANVAS] edge {} has unknown origin {:?}; treating it as user",
                    edge.id,
                    edge.origin
                );
                EdgeOrigin::User
            });
            let info = registry.get(&other);
            Some(Connection {
                node_id: other,
                title: info.and_then(|node| node.title.clone()),
                group_id: info.and_then(|node| node.group_id.clone()),
                group_title: info.and_then(|node| node.group_title.clone()),
                direction,
                origin,
                label: edge.label,
                created_at: edge.created_at,
            })
        })
        .collect()
}

fn live_renderer_ids(state: &AppState) -> HashSet<String> {
    state
        .terminals
        .iter()
        .filter_map(|terminal| terminal.renderer_terminal_id.clone())
        .collect()
}

enum EdgeEndpointError {
    MissingSource,
    MissingDestination,
    SelfEdge,
}

fn resolve_edge_endpoints<F>(
    from: &str,
    to: &str,
    mut resolve: F,
) -> Result<(String, String), EdgeEndpointError>
where
    F: FnMut(&str) -> Option<String>,
{
    let from_id = resolve(from).ok_or(EdgeEndpointError::MissingSource)?;
    let to_id = resolve(to).ok_or(EdgeEndpointError::MissingDestination)?;
    if from_id == to_id {
        return Err(EdgeEndpointError::SelfEdge);
    }
    Ok((from_id, to_id))
}

/// Normalize a window's published model against the currently-live terminal
/// leaves. A terminal can close between renderer snapshot and HTTP publish, so
/// unknown nodes are intentionally omitted rather than rejecting the fresh data.
fn resolve_live_nodes<F>(nodes: Vec<NodeInfo>, mut resolve: F) -> HashMap<String, NodeInfo>
where
    F: FnMut(&str) -> Option<String>,
{
    let mut resolved = HashMap::new();
    for mut node in nodes {
        let Some(renderer_id) = resolve(&node.node_id) else {
            continue;
        };
        node.node_id = renderer_id.clone();
        resolved.insert(renderer_id, node);
    }
    resolved
}

fn merged_registry(registries: &HashMap<String, WindowRegistry>) -> HashMap<String, NodeInfo> {
    let mut merged = HashMap::new();
    for registry in registries.values() {
        for (node_id, node) in &registry.nodes {
            merged.insert(node_id.clone(), node.clone());
        }
    }
    merged
}

fn graph_nodes_and_groups(
    registry: &HashMap<String, NodeInfo>,
    live: &HashSet<String>,
) -> (Vec<NodeInfo>, Vec<GroupInfo>) {
    let mut nodes: Vec<_> = registry
        .values()
        .filter(|node| live.contains(&node.node_id))
        .cloned()
        .collect();
    nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));

    let mut groups = HashMap::new();
    for node in &nodes {
        if let Some(group_id) = &node.group_id {
            groups.insert(
                group_id.clone(),
                GroupInfo {
                    group_id: group_id.clone(),
                    group_title: node.group_title.clone(),
                },
            );
        }
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by(|a, b| a.group_id.cmp(&b.group_id));
    (nodes, groups)
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn store_error() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "canvas edge store is unavailable",
    )
}

pub async fn get_graph(State(state): State<AppState>) -> Response {
    let live = live_renderer_ids(&state);
    let edges = match state.canvas_store.all_edges() {
        Ok(edges) => filter_live(edges, &live),
        Err(_) => return store_error(),
    };
    let registry = merged_registry(&state.canvas_nodes.read());
    let (nodes, groups) = graph_nodes_and_groups(&registry, &live);
    Json(CanvasGraph {
        version: 1,
        nodes,
        groups,
        edges,
    })
    .into_response()
}

pub async fn create_edge(
    State(state): State<AppState>,
    request: Result<Json<CreateEdgeReq>, JsonRejection>,
) -> Response {
    let Json(request) = match request {
        Ok(request) => request,
        // Axum normally maps a well-formed JSON type mismatch to 422. Origin is
        // external input with a strict renderer contract, so this endpoint makes
        // every invalid request a clear client-side 400 instead.
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid canvas edge request"),
    };
    let (from_id, to_id) = match resolve_edge_endpoints(&request.from, &request.to, |id| {
        state.resolve_renderer_id(id)
    }) {
        Ok(ids) => ids,
        Err(EdgeEndpointError::MissingSource) => {
            return error(StatusCode::NOT_FOUND, "source terminal not found")
        }
        Err(EdgeEndpointError::MissingDestination) => {
            return error(StatusCode::NOT_FOUND, "destination terminal not found")
        }
        Err(EdgeEndpointError::SelfEdge) => {
            return error(
                StatusCode::BAD_REQUEST,
                "a canvas edge cannot connect a terminal to itself",
            )
        }
    };
    let edge = CanvasEdge {
        id: format!("ce-{}", uuid::Uuid::new_v4()),
        from_id,
        to_id,
        label: request.label,
        origin: request
            .origin
            .unwrap_or(EdgeOrigin::User)
            .as_str()
            .to_string(),
        created_at: Utc::now().timestamp_millis(),
    };
    match state.canvas_store.insert_edge(&edge) {
        Ok(InsertOutcome::Inserted(edge)) | Ok(InsertOutcome::Existing(edge)) => {
            (StatusCode::OK, Json(edge)).into_response()
        }
        Err(_) => store_error(),
    }
}

pub async fn delete_edge(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.canvas_store.delete_edge(&id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "canvas edge not found"),
        Err(_) => store_error(),
    }
}

pub async fn patch_edge(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Result<Json<PatchEdgeReq>, JsonRejection>,
) -> Response {
    let Json(request) = match request {
        Ok(request) => request,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid canvas edge patch request"),
    };
    match state
        .canvas_store
        .update_label(&id, request.label.as_deref())
    {
        Ok(false) => error(StatusCode::NOT_FOUND, "canvas edge not found"),
        Err(_) => store_error(),
        Ok(true) => match state.canvas_store.all_edges() {
            Ok(edges) => match edges.into_iter().find(|edge| edge.id == id) {
                Some(edge) => (StatusCode::OK, Json(edge)).into_response(),
                // A concurrent delete after the successful update is a confirmed
                // absence, not an unavailable store.
                None => error(StatusCode::NOT_FOUND, "canvas edge not found"),
            },
            Err(_) => store_error(),
        },
    }
}

pub async fn put_nodes(
    State(state): State<AppState>,
    request: Result<Json<PutNodesReq>, JsonRejection>,
) -> Response {
    let Json(request) = match request {
        Ok(request) => request,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid canvas node request"),
    };
    let window_id = request.window_id.trim();
    if window_id.is_empty() {
        return error(StatusCode::BAD_REQUEST, "windowId is required");
    }

    let nodes = resolve_live_nodes(request.nodes, |id| state.resolve_renderer_id(id));

    let mut registries = state.canvas_nodes.write();
    if let Some(existing) = registries.get(window_id) {
        if request.revision < existing.revision {
            return error(StatusCode::CONFLICT, "canvas node revision is stale");
        }
    }
    registries.insert(
        window_id.to_string(),
        WindowRegistry {
            revision: request.revision,
            nodes,
        },
    );
    (StatusCode::OK, Json(json!({ "status": "updated" }))).into_response()
}

pub async fn get_connections(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(node_id) = state.resolve_renderer_id(&id) else {
        return error(StatusCode::NOT_FOUND, "terminal not found");
    };
    let live = live_renderer_ids(&state);
    let edges = match state.canvas_store.edges_for(&node_id) {
        Ok(edges) => filter_live(edges, &live),
        Err(_) => return store_error(),
    };
    let registry = merged_registry(&state.canvas_nodes.read());
    Json(json!({
        "nodeId": node_id,
        "connections": to_connections(&node_id, edges, &registry),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(id: &str, from: &str, to: &str) -> CanvasEdge {
        CanvasEdge {
            id: id.into(),
            from_id: from.into(),
            to_id: to.into(),
            label: None,
            origin: "user".into(),
            created_at: 1,
        }
    }

    fn live_set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    fn registry(pairs: &[(&str, &str, &str, &str)]) -> HashMap<String, NodeInfo> {
        pairs
            .iter()
            .map(|(id, title, group_id, group_title)| {
                (
                    (*id).to_string(),
                    NodeInfo {
                        node_id: (*id).to_string(),
                        title: Some((*title).to_string()),
                        group_id: Some((*group_id).to_string()),
                        group_title: Some((*group_title).to_string()),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn keeps_edges_whose_endpoints_are_both_live() {
        assert_eq!(
            filter_live(vec![edge("ce-1", "a", "b")], &live_set(&["a", "b"])).len(),
            1
        );
    }

    #[test]
    fn drops_edges_with_a_dead_endpoint_without_deleting_them() {
        assert!(filter_live(vec![edge("ce-1", "a", "gone")], &live_set(&["a"])).is_empty());
    }

    #[test]
    fn labels_outgoing_and_incoming_from_the_asking_node() {
        let connections = to_connections(
            "me",
            vec![edge("ce-1", "me", "other"), edge("ce-2", "caller", "me")],
            &registry(&[]),
        );
        assert_eq!(
            connections
                .iter()
                .find(|connection| connection.node_id == "other")
                .unwrap()
                .direction,
            ConnectionDirection::Outgoing
        );
        assert_eq!(
            connections
                .iter()
                .find(|connection| connection.node_id == "caller")
                .unwrap()
                .direction,
            ConnectionDirection::Incoming
        );
    }

    #[test]
    fn joins_title_and_group_from_the_registry() {
        let connections = to_connections(
            "me",
            vec![edge("ce-1", "me", "other")],
            &registry(&[("other", "server", "tb-api", "api")]),
        );
        assert_eq!(connections[0].title.as_deref(), Some("server"));
        assert_eq!(connections[0].group_id.as_deref(), Some("tb-api"));
        assert_eq!(connections[0].group_title.as_deref(), Some("api"));
    }

    #[test]
    fn emits_explicit_nulls_for_a_node_missing_from_the_registry() {
        let connections = to_connections("me", vec![edge("ce-1", "me", "ghost")], &registry(&[]));
        assert_eq!(connections[0].node_id, "ghost");
        assert!(connections[0].title.is_none());
        assert!(connections[0].group_id.is_none());
        assert!(connections[0].group_title.is_none());
    }

    #[test]
    fn a_node_with_no_edges_yields_an_empty_list() {
        assert!(to_connections("me", vec![], &registry(&[])).is_empty());
    }

    #[test]
    fn a_self_edge_is_ignored_rather_than_reported_twice() {
        assert!(to_connections("me", vec![edge("ce-1", "me", "me")], &registry(&[])).is_empty());
    }

    #[test]
    fn unknown_stored_origin_keeps_the_connection_and_defaults_to_user() {
        let mut malformed = edge("ce-bad", "me", "other");
        malformed.origin = "banana".into();
        let connections = to_connections("me", vec![malformed], &registry(&[]));
        assert_eq!(
            connections.len(),
            1,
            "a malformed secondary field must not hide a neighbour"
        );
        assert_eq!(connections[0].node_id, "other");
        assert_eq!(connections[0].origin, EdgeOrigin::User);
    }

    #[test]
    fn endpoint_resolution_rejects_a_raw_self_edge() {
        assert!(matches!(
            resolve_edge_endpoints("tm-a", "tm-a", |id| Some(id.to_string())),
            Err(EdgeEndpointError::SelfEdge)
        ));
    }

    #[test]
    fn endpoint_resolution_rejects_two_input_ids_that_resolve_to_one_leaf() {
        let resolve = |id: &str| match id {
            "pc-a" | "tm-a" => Some("tm-a".to_string()),
            _ => None,
        };
        assert!(matches!(
            resolve_edge_endpoints("pc-a", "tm-a", resolve),
            Err(EdgeEndpointError::SelfEdge)
        ));
    }

    #[test]
    fn node_publish_skips_an_unknown_terminal_but_keeps_live_nodes() {
        let nodes = vec![
            NodeInfo {
                node_id: "pc-live".into(),
                ..Default::default()
            },
            NodeInfo {
                node_id: "tm-gone".into(),
                ..Default::default()
            },
        ];
        let resolved =
            resolve_live_nodes(nodes, |id| (id == "pc-live").then(|| "tm-live".to_string()));
        assert_eq!(resolved.len(), 1);
        assert!(resolved.contains_key("tm-live"));
        assert_eq!(resolved["tm-live"].node_id, "tm-live");
    }

    #[test]
    fn graph_json_has_the_renderer_contract_keys() {
        let graph = CanvasGraph {
            version: 1,
            nodes: vec![NodeInfo {
                node_id: "tm-a".into(),
                ..Default::default()
            }],
            groups: vec![],
            edges: vec![edge("ce-1", "tm-a", "tm-b")],
        };
        let value = serde_json::to_value(graph).unwrap();
        let keys: HashSet<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, HashSet::from(["version", "nodes", "groups", "edges"]));
        assert_eq!(value["version"], 1);
    }

    #[test]
    fn an_unknown_origin_fails_to_deserialise() {
        assert!(serde_json::from_value::<CreateEdgeReq>(json!({
            "from": "tm-a", "to": "tm-b", "origin": "automation"
        }))
        .is_err());
    }

    #[test]
    fn merging_window_registries_keeps_nodes_from_each_window() {
        let registries = HashMap::from([
            (
                "one".into(),
                WindowRegistry {
                    revision: 2,
                    nodes: registry(&[("tm-a", "a", "tb-a", "A")]),
                },
            ),
            (
                "two".into(),
                WindowRegistry {
                    revision: 4,
                    nodes: registry(&[("tm-b", "b", "tb-b", "B")]),
                },
            ),
        ]);
        let merged = merged_registry(&registries);
        assert!(merged.contains_key("tm-a"));
        assert!(merged.contains_key("tm-b"));
    }
}
