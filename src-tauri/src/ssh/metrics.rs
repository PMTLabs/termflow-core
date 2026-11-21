//! Static remote metrics collection. Session execution and scheduling are separate.
pub mod protocol;

const COLLECT: &str = include_str!("metrics/collect.sh");

/// One command and its matching parser nonce; pass the command to one exec.
pub fn collector_command() -> (String, String) {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let command = encode(&nonce, COLLECT).expect("UUID generated as lowercase hex");
    (command, nonce)
}

fn encode(nonce: &str, script: &str) -> Option<String> {
    protocol::valid_nonce(nonce).then(|| {
        format!("sh -c '{}' termflow-metrics '{nonce}'", script.replace('\'', "'\\''"))
    })
}
