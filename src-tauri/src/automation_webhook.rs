//! Sending an automation's webhook destination.
//!
//! The webhook URL is deliberately confined to the request builder. In particular, no error type
//! in this module retains a `reqwest::Error`: its `Display` and `Debug` implementations can contain
//! the request URL, which may itself contain a credential.

use std::time::Duration;

use crate::automation_store::{WebhookProvider, WebhookStep};

/// Bound one webhook attempt. A webhook send is dispatched by the engine; this timeout prevents a
/// peer that accepts a connection but never replies from holding that dispatch indefinitely.
const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(10);

/// The safe-to-render class of a transport failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookTransportClass {
    Connect,
    Timeout,
    Request,
}

impl std::fmt::Display for WebhookTransportClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect => f.write_str("connect"),
            Self::Timeout => f.write_str("timeout"),
            Self::Request => f.write_str("request"),
        }
    }
}

/// A webhook failure that is safe to put in an automation activity entry.
///
/// This intentionally stores only an HTTP status or a coarse transport class. Do not add a
/// `reqwest::Error`, request URL, or response body here: all of those can carry the user's secret
/// endpoint into a display or log surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookError {
    Transport(WebhookTransportClass),
    Status(reqwest::StatusCode),
}

impl WebhookError {
    fn from_transport(error: reqwest::Error) -> Self {
        let class = if error.is_timeout() {
            WebhookTransportClass::Timeout
        } else if error.is_connect() {
            WebhookTransportClass::Connect
        } else {
            WebhookTransportClass::Request
        };
        Self::Transport(class)
    }
}

impl std::fmt::Display for WebhookError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(class) => write!(f, "webhook transport failed ({class})"),
            Self::Status(status) => write!(f, "webhook returned status {status}"),
        }
    }
}

impl std::error::Error for WebhookError {}

/// Send a configured webhook body to its destination.
pub async fn send(webhook: &WebhookStep) -> Result<(), WebhookError> {
    send_body(webhook, &webhook.body).await
}

/// Send a resolved webhook body to its destination.
///
/// Preset providers always receive a newly-created JSON wrapper. `message` is encoded as a JSON
/// value, never interpolated into a JSON string. A Custom endpoint instead receives `message`'s
/// bytes unchanged, including whitespace and duplicate JSON object keys. The engine uses this only
/// after resolving an opted-in capture substitution; normal callers should use [`send`].
pub async fn send_body(webhook: &WebhookStep, message: &str) -> Result<(), WebhookError> {
    let body = payload(webhook.provider, message);
    let client = reqwest::Client::builder()
        .timeout(WEBHOOK_TIMEOUT)
        .build()
        .map_err(WebhookError::from_transport)?;
    let response = client
        .post(&webhook.url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(WebhookError::from_transport)?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(WebhookError::Status(response.status()))
    }
}

fn payload(provider: WebhookProvider, message: &str) -> Vec<u8> {
    match provider {
        WebhookProvider::Discord => serde_json::to_vec(&serde_json::json!({ "content": message }))
            .expect("a string is always serializable as JSON"),
        WebhookProvider::Slack => serde_json::to_vec(&serde_json::json!({ "text": message }))
            .expect("a string is always serializable as JSON"),
        WebhookProvider::Teams => serde_json::to_vec(&serde_json::json!({
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "text": message,
        }))
        .expect("a string is always serializable as JSON"),
        WebhookProvider::Custom => message.as_bytes().to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation_store::AutomationGraph;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc::{self, Receiver};

    fn webhook(provider: WebhookProvider, url: String, body: &str) -> WebhookStep {
        WebhookStep {
            provider,
            url,
            body: body.to_string(),
            substitute: false,
        }
    }

    /// A one-request loopback server. It is deliberately a local listener rather than a mock so
    /// the assertions cover the actual reqwest request bytes without contacting any real network.
    fn capture_endpoint() -> (String, Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback capture listener");
        let url = format!(
            "http://{}",
            listener.local_addr().expect("listener address")
        );
        let (sent, received) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept webhook request");
            let request = read_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .expect("reply to webhook request");
            sent.send(request).expect("return captured request");
        });
        (url, received)
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("set capture read timeout");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        let mut expected = None;
        loop {
            let read = stream.read(&mut buffer).expect("read webhook request");
            assert_ne!(read, 0, "client closed before completing request");
            request.extend_from_slice(&buffer[..read]);
            if expected.is_none() {
                expected = content_length(&request).map(|length| {
                    request
                        .windows(4)
                        .position(|bytes| bytes == b"\r\n\r\n")
                        .expect("headers terminate")
                        + 4
                        + length
                });
            }
            if expected.is_some_and(|length| request.len() >= length) {
                return request;
            }
        }
    }

    fn content_length(request: &[u8]) -> Option<usize> {
        let header_end = request.windows(4).position(|bytes| bytes == b"\r\n\r\n")?;
        let headers =
            std::str::from_utf8(&request[..header_end]).expect("request headers are text");
        headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().expect("numeric content length"))
        })
    }

    fn captured_body(request: Vec<u8>) -> Vec<u8> {
        let header_end = request
            .windows(4)
            .position(|bytes| bytes == b"\r\n\r\n")
            .expect("headers terminate");
        request[header_end + 4..].to_vec()
    }

    fn receive_body(receiver: Receiver<Vec<u8>>) -> Vec<u8> {
        captured_body(
            receiver
                .recv_timeout(Duration::from_secs(3))
                .expect("webhook capture completed"),
        )
    }

    #[tokio::test]
    async fn discord_wraps_the_message_in_content() {
        let (url, captured) = capture_endpoint();
        send(&webhook(WebhookProvider::Discord, url, "build failed"))
            .await
            .expect("discord webhook succeeds");
        assert_eq!(receive_body(captured), br#"{"content":"build failed"}"#);
    }

    #[tokio::test]
    async fn slack_wraps_the_message_in_text() {
        let (url, captured) = capture_endpoint();
        send(&webhook(WebhookProvider::Slack, url, "build failed"))
            .await
            .expect("slack webhook succeeds");
        assert_eq!(receive_body(captured), br#"{"text":"build failed"}"#);
    }

    #[tokio::test]
    async fn teams_uses_a_message_card() {
        let (url, captured) = capture_endpoint();
        send(&webhook(WebhookProvider::Teams, url, "build failed"))
            .await
            .expect("teams webhook succeeds");
        let body: serde_json::Value =
            serde_json::from_slice(&receive_body(captured)).expect("teams payload is JSON");
        assert_eq!(body["@type"], "MessageCard");
        assert_eq!(body["text"], "build failed");
    }

    #[tokio::test]
    async fn a_custom_endpoint_posts_the_body_verbatim() {
        let (url, captured) = capture_endpoint();
        let raw = "{ \"z\" : 1, \"a\" : 2, \"a\" : 3 }\n";
        send(&webhook(WebhookProvider::Custom, url, raw))
            .await
            .expect("custom webhook succeeds");
        assert_eq!(receive_body(captured), raw.as_bytes());
    }

    #[tokio::test]
    async fn a_capture_containing_json_syntax_cannot_break_a_preset_payload() {
        let (url, captured) = capture_endpoint();
        let capture = "quote: \"; slash: \\; newline:\n{\"injected\":true}";
        send(&webhook(WebhookProvider::Discord, url, capture))
            .await
            .expect("discord webhook succeeds");
        let body: serde_json::Value =
            serde_json::from_slice(&receive_body(captured)).expect("preset payload remains JSON");
        assert_eq!(body, serde_json::json!({ "content": capture }));
        assert_eq!(body.as_object().expect("object payload").len(), 1);
    }

    #[tokio::test]
    async fn a_real_transport_error_never_renders_the_url() {
        // Reserving then dropping a loopback port makes a genuine connection failure without any
        // traffic leaving this machine. The request URL deliberately contains all three values that
        // must not reach a display surface.
        let reserved = TcpListener::bind("127.0.0.1:0").expect("reserve an unused loopback port");
        let port = reserved.local_addr().expect("reserved address").port();
        drop(reserved);
        let url = format!("http://127.0.0.1:{port}/url-leak-path/credential-token");
        let graph = AutomationGraph {
            monitor: None,
            parse: None,
            cond: None,
            timer: None,
            action: None,
            webhook: Some(webhook(
                WebhookProvider::Discord,
                url.clone(),
                "build failed",
            )),
            layout: None,
        };
        let graph_debug = format!("{graph:?}");
        assert!(graph_debug.contains("url: \"<redacted>\""));
        assert!(!graph_debug.contains(&url));
        let raw = reqwest::Client::builder()
            // Do not let a machine-wide proxy turn this local refusal into a real network request.
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("build client")
            .post(&url)
            .send()
            .await
            .expect_err("dropped loopback port refuses the request");

        assert_eq!(
            raw.url()
                .expect("reqwest attaches the request URL to this transport error")
                .as_str(),
            url,
            "this must be a real URL-bearing reqwest error before conversion"
        );
        let rendered = WebhookError::from_transport(raw).to_string();
        for secret in [&url, "127.0.0.1", "url-leak-path"] {
            assert!(
                !rendered.contains(secret),
                "safe webhook error leaked {secret:?}: {rendered:?}"
            );
        }
        assert!(
            rendered.starts_with("webhook transport failed ("),
            "the error renders only its coarse class: {rendered:?}"
        );
    }

    #[test]
    fn webhook_and_graph_debug_never_render_the_endpoint() {
        let secret = "https://hooks.example.invalid/debug-credential";
        let step = webhook(WebhookProvider::Discord, secret.to_string(), "done");
        let graph = AutomationGraph {
            monitor: None,
            parse: None,
            cond: None,
            timer: None,
            action: None,
            webhook: Some(step.clone()),
            layout: None,
        };

        for rendered in [format!("{step:?}"), format!("{graph:?}")] {
            assert!(rendered.contains("<redacted>"), "debug did not mark the field: {rendered}");
            assert!(!rendered.contains(secret), "debug leaked the endpoint: {rendered}");
        }
    }
}
