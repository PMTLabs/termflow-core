//! Shared effective target resolver. Hops are in network traversal order.
use super::store::{Auth, Persisted, StoreError};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    pub identity_file: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTarget {
    pub hops: Vec<Hop>,
    pub extra_options: Vec<(String, String)>,
}
pub fn resolve(store: &Persisted, connection_id: &str) -> Result<ResolvedTarget, StoreError> {
    // Includes missing/self/nested jump checks (all cycles beyond self
    // necessarily contain a nested jump). Keep store and resolver policy shared.
    store.validate()?;
    let connection = store
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| StoreError {
            field: Some("connectionId".into()),
            code: "not-found".into(),
            message: "Connection not found".into(),
        })?;
    let mut hops = Vec::new();
    let jump = connection
        .jump_connection_id
        .as_ref()
        .map(|id| {
            store.connections.iter().find(|c| &c.id == id).ok_or_else(|| {
                StoreError::field("jumpConnectionId", "not-found")
            })
        })
        .transpose()?;
    for c in jump.into_iter().chain(std::iter::once(connection)) {
        hops.push(Hop {
            connection_id: c.id.clone(),
            host: super::store::bare_host(&c.host).into(),
            port: c.port,
            user: super::store_adapter::effective_user(&c.user)
                .map_err(|_| StoreError::field("user", "effective-user-unavailable"))?,
            auth: c.auth.clone(),
            identity_file: c.identity_file.clone(),
        });
    }
    Ok(ResolvedTarget {
        hops,
        extra_options: connection.extra_options.clone(),
    })
}
