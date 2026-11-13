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
    for c in connection
        .jump_connection_id
        .as_ref()
        .and_then(|id| store.connections.iter().find(|c| &c.id == id))
        .into_iter()
        .chain(std::iter::once(connection))
    {
        hops.push(Hop {
            connection_id: c.id.clone(),
            host: c.host.clone(),
            port: c.port,
            user: c.user.clone(),
            auth: c.auth.clone(),
            identity_file: c.identity_file.clone(),
        });
    }
    Ok(ResolvedTarget {
        hops,
        extra_options: connection.extra_options.clone(),
    })
}
