//! `connect_existing` against a real endpoint. A duplex cannot stand in: the
//! server pid is a property of the kernel pipe object, and "nothing listens
//! here" is an error the operating system reports, not something a byte stream
//! can say.

use super::*;
use crate::state::ChannelPayload;
use dashmap::DashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

fn deps() -> PtyHostDeps {
    PtyHostDeps {
        lifecycle_token: "tok".into(),
        output_tx: tokio::sync::broadcast::channel::<ChannelPayload>(16).0,
        output_produced: Arc::new(AtomicU64::new(0)),
        on_exit: Arc::new(|_, _, _| {}),
        on_gap: Arc::new(|_| {}),
        resolve_process: Arc::new(|k: &str| Some(k.to_string())),
        on_disconnect: Arc::new(|| {}),
        stream_offsets: Arc::new(DashMap::new()),
    }
}

/// An endpoint nothing has ever listened on.
fn missing_endpoint() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    if cfg!(windows) {
        format!(r"\\.\pipe\tf-connect-missing-{id}")
    } else {
        // Short on purpose: a socket path longer than sun_path is rejected before it
        // is ever looked up (macOS temp dirs are long), which says nothing about the host.
        format!("/tmp/tfm-{}.sock", &id[..12])
    }
}

#[cfg(any(windows, unix))]
#[tokio::test]
async fn an_endpoint_nothing_listens_on_is_reported_gone() {
    let failure = connect_existing(&missing_endpoint(), Duration::ZERO, deps())
        .await
        .err()
        .expect("nothing to connect to");
    assert!(endpoint_is_gone(&failure), "{failure:?}");
}

#[test]
fn only_a_missing_or_refused_endpoint_is_gone() {
    use std::io::{Error, ErrorKind};
    assert!(endpoint_is_gone(&Error::from(ErrorKind::NotFound)));
    assert!(endpoint_is_gone(&Error::from(ErrorKind::ConnectionRefused)));
    for kind in [ErrorKind::TimedOut, ErrorKind::WouldBlock, ErrorKind::PermissionDenied, ErrorKind::Other] {
        assert!(!endpoint_is_gone(&Error::from(kind)), "{kind:?} says nothing about the host being gone");
    }
}

#[cfg(windows)]
mod windows_pipe {
    use super::*;
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

    /// An older host that is adopted rather than started has no record to take
    /// its origin from, and the connection is the only place to find it. A
    /// client that never recorded the server pid cannot be classified, which
    /// callers must read as "inside the update payload".
    #[tokio::test]
    async fn adopted_host_origin_is_found_via_the_connection_pid() {
        let pipe = format!(r"\\.\pipe\tf-adopt-origin-{}", uuid::Uuid::new_v4());
        let server = ServerOptions::new().first_pipe_instance(true).create(&pipe).unwrap();
        let accept = tokio::spawn(async move {
            let _ = server.connect().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });

        let client = connect_existing(&pipe, GRACE_ENDPOINT_ONLY, deps()).await.expect("connect to the pipe");

        // The serving process is this one, which runs from neither the Velopack
        // root nor the runtime dir: a recorded pid classifies it as outside.
        assert_eq!(client.exe_in_payload(), Some(false));
        client.close_transport().await;
        accept.abort();
    }

    /// A host that is between two accepted connections has no free pipe instance
    /// for a moment. That is busy, not gone.
    #[tokio::test]
    async fn a_pipe_with_no_free_instance_is_not_reported_gone() {
        let pipe = format!(r"\\.\pipe\tf-connect-busy-{}", uuid::Uuid::new_v4());
        let server = ServerOptions::new().first_pipe_instance(true).create(&pipe).unwrap();
        let _first = ClientOptions::new().open(&pipe).expect("the one instance is taken");
        server.connect().await.unwrap();

        let failure = connect_existing(&pipe, Duration::ZERO, deps())
            .await
            .err()
            .expect("every instance is in use");
        assert!(!endpoint_is_gone(&failure), "{failure:?}");
    }
}
