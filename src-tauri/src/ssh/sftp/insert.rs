use super::{error, FsCode, FsError, FsOutcome};

pub(crate) const OPERATION: &str = "insertPath";

/// Encoder seam for future positively identified PowerShell or cmd remotes.
pub(crate) enum RemoteDialect {
    Posix,
}

impl RemoteDialect {
    pub(crate) fn quote(self, path: &str) -> Result<String, FsError> {
        match self {
            Self::Posix => quote_posix(path),
        }
    }
}

pub(crate) fn quote_posix(path: &str) -> Result<String, FsError> {
    let detail = if !path.starts_with('/') {
        "Terminal insertion requires an absolute remote path."
    } else if path.chars().any(char::is_control) {
        "Terminal insertion refuses paths containing control characters."
    } else {
        return Ok(format!("'{}'", path.replace('\'', "'\\''")));
    };
    Err(error(OPERATION, path, FsCode::InvalidPath, FsOutcome::Unchanged, detail))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        identity_index::IdentityIndex,
        ssh::{
            session::{LaunchState, SessionState},
            tests::{hop, wait_state, Fixture, Server},
        },
    };

    const LEAF: &str = "tm-a";
    const PROCESS: &str = "pc-a";
    const PATH: &str = "/a b";

    fn fixture() -> (Fixture, IdentityIndex) {
        let fixture = Fixture::new(Server::new(1, "alice"), vec![hop("c-a", "alice")], true);
        let identity = IdentityIndex::new();
        identity.index(PROCESS, Some(LEAF), PROCESS);
        (fixture, identity)
    }

    async fn renderer_check(fixture: &Fixture, identity: &IdentityIndex) -> u64 {
        fixture.connected().await;
        let launch = fixture.registry.current_launch(LEAF).unwrap();
        assert!(launch.connected);
        assert_eq!(launch.state, Some(LaunchState::Running));
        assert_eq!(launch.process_id, identity.process_for_leaf(LEAF));
        launch.generation
    }

    fn refused(fixture: &Fixture, identity: &IdentityIndex, generation: u64, code: FsCode) {
        let mut calls = 0;
        let result = fixture.registry.insert_path(LEAF, generation, PATH, identity, |_| {
            calls += 1;
            Ok(())
        });
        assert_eq!(result.unwrap_err().code, code);
        assert_eq!(calls, 0);
    }

    #[tokio::test]
    async fn insert_refused_when_ended_arrives_after_renderer_check() {
        let (fixture, identity) = fixture();
        let generation = renderer_check(&fixture, &identity).await;
        fixture.registry.on_launch_lifecycle(
            LEAF, generation, 2, LaunchState::Ended, Some(PROCESS.into()),
        ).unwrap();
        assert_eq!(identity.process_for_leaf(LEAF).as_deref(), Some(PROCESS));
        refused(&fixture, &identity, generation, FsCode::NotConnected);
    }

    #[tokio::test]
    async fn insert_refused_when_process_replaced_after_renderer_check() {
        let (fixture, identity) = fixture();
        let generation = renderer_check(&fixture, &identity).await;
        identity.index("pc-replacement", Some(LEAF), "pc-replacement");
        refused(&fixture, &identity, generation, FsCode::Stale);
    }

    #[tokio::test]
    async fn insert_refused_when_generation_changes_after_renderer_check() {
        let (fixture, identity) = fixture();
        let generation = renderer_check(&fixture, &identity).await;
        let next = fixture.registry.reconnect(LEAF, || true).unwrap();
        assert_ne!(generation, next.generation);
        refused(&fixture, &identity, generation, FsCode::Stale);
    }

    #[tokio::test]
    async fn insert_refused_while_typed_or_prompting() {
        let (connected, identity) = fixture();
        let generation = renderer_check(&connected, &identity).await;
        connected.registry.on_launch_lifecycle(
            LEAF, generation, 2, LaunchState::Typed, Some(PROCESS.into()),
        ).unwrap();
        refused(&connected, &identity, generation, FsCode::NotConnected);

        let (prompting, identity) = fixture();
        prompting.registry.open(LEAF, "c-a", false, || true).unwrap();
        let view = wait_state(&prompting.registry, LEAF, false, SessionState::NeedsSecret).await;
        prompting.registry.on_launch_lifecycle(
            LEAF, view.generation, 1, LaunchState::Running, Some(PROCESS.into()),
        ).unwrap();
        refused(&prompting, &identity, view.generation, FsCode::NotConnected);
    }

    #[tokio::test]
    async fn insert_writes_once_to_own_process_without_newline() {
        let (fixture, identity) = fixture();
        identity.index("pc-other", Some("tm-other"), "pc-other");
        let generation = renderer_check(&fixture, &identity).await;
        let quoted = RemoteDialect::Posix.quote(PATH).unwrap();
        let mut writes = Vec::new();
        fixture.registry.insert_path(LEAF, generation, PATH, &identity, |process| {
            writes.push((process.to_owned(), quoted.as_bytes().to_vec()));
            Ok(())
        }).unwrap();
        assert_eq!(writes, vec![(PROCESS.to_owned(), b"'/a b'".to_vec())]);
    }

    #[test]
    fn posix_paths_quote_space_apostrophe_dollar_backtick_backslash_and_unicode() {
        assert_eq!(
            quote_posix(r"/a b/O'Brien/$HOME/`cmd`/a\b/雪").unwrap().as_bytes(),
            r"'/a b/O'\''Brien/$HOME/`cmd`/a\b/雪'".as_bytes()
        );
    }

    #[test]
    fn control_path_insertion_refused() {
        for path in ["/a\rb", "/a\nb", "/a\0b", "/a\x1bb", "/a\x7fb", "/a\tb", "relative"] {
            assert_eq!(quote_posix(path).unwrap_err().code, FsCode::InvalidPath);
        }
    }
}
