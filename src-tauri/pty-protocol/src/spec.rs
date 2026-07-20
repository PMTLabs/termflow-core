use serde::{Deserialize, Serialize};

/// Fully-resolved instructions to spawn one PTY child. Built by the GUI
/// (which owns all profile logic) and executed verbatim by the sidecar
/// (which owns portable-pty). No profile logic lives in the sidecar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnSpec {
    pub shell: String,
    pub args: Vec<String>,
    /// Env vars to SET on the child (order preserved).
    pub env: Vec<(String, String)>,
    /// Env vars to REMOVE from the inherited environment (foreign-terminal scrub).
    pub env_remove: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_spec_roundtrips_through_json() {
        let spec = SpawnSpec {
            shell: "powershell.exe".into(),
            args: vec!["-NoExit".into()],
            env: vec![("TERM_PROGRAM".into(), "TermFlow".into())],
            env_remove: vec!["WT_SESSION".into()],
            cwd: Some("D:/work".into()),
            cols: 120,
            rows: 30,
        };
        let json = serde_json::to_string(&spec).unwrap();
        let back: SpawnSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back, spec);
    }
}
