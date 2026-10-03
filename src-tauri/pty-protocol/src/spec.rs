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
    /// Start the child's cursor on this row (1-based) instead of row 1, by creating the
    /// Windows pseudoconsole with `PSEUDOCONSOLE_INHERIT_CURSOR` and answering its startup
    /// cursor query with it. Set for a RESTORED terminal, whose renderer has already replayed
    /// the previous session above the new shell: ConPTY addresses the screen absolutely
    /// (PSReadLine repaints with `ESC[<row>;<col>H`), so it must agree with the renderer on
    /// the prompt's row or the first keystroke lands on the replayed history.
    ///
    /// `None` (every other spawn, and any non-Windows host) changes nothing. A host that
    /// predates this field ignores it, and one whose ConPTY is not the bundled one does too;
    /// it advertises `CAP_INHERIT_CURSOR` exactly when it will honour it, and the GUI only
    /// relies on the row when it saw that bit.
    #[serde(default)]
    pub initial_cursor_row: Option<u16>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(initial_cursor_row: Option<u16>) -> SpawnSpec {
        SpawnSpec {
            shell: "powershell.exe".into(),
            args: vec!["-NoExit".into()],
            env: vec![("TERM_PROGRAM".into(), "TermFlow".into())],
            env_remove: vec!["WT_SESSION".into()],
            cwd: Some("D:/work".into()),
            cols: 120,
            rows: 30,
            initial_cursor_row,
        }
    }

    #[test]
    fn spawn_spec_roundtrips_through_json() {
        for row in [None, Some(24)] {
            let spec = spec(row);
            let json = serde_json::to_string(&spec).unwrap();
            let back: SpawnSpec = serde_json::from_str(&json).unwrap();
            assert_eq!(back, spec);
        }
    }

    /// A GUI that predates the field sends a spec without it, and the host must read that as
    /// `None`. (The other direction, a host that predates the field being sent one with it, is
    /// serde's default of ignoring unknown fields: this struct has no `deny_unknown_fields`.)
    #[test]
    fn the_cursor_row_is_optional_on_the_wire() {
        let old = r#"{"shell":"cmd.exe","args":[],"env":[],"env_remove":[],"cwd":null,"cols":80,"rows":24}"#;
        let parsed: SpawnSpec = serde_json::from_str(old).unwrap();
        assert_eq!(parsed.initial_cursor_row, None);
    }
}
