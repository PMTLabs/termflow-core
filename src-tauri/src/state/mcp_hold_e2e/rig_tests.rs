use super::*;
use crate::pty_host_client::real_process::{self, OwnedChild, RealHost, TestDir};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub(super) struct Rig {
    pub hosts: Vec<RealHost>,
    pub bin: PathBuf,
    pub bun: PathBuf,
    pub token: String,
    pub bearer: String,
    pub marker: String,
    pub api_port: u16,
    backend: tokio::task::JoinHandle<()>,
    _gate: std::sync::MutexGuard<'static, ()>,
}
impl Rig {
    // Deliberately held for the rig's entire lifetime, shared with process-inspection tests.
    #[allow(clippy::await_holding_lock)]
    pub async fn new(old: bool) -> Option<Self> {
        let bin = real_process::host_binary(if old {
            "TERMFLOW_E2E_OLD_HOST_BIN"
        } else {
            "TERMFLOW_PTY_HOST_BIN"
        })?;
        let gate = crate::pty_host_client::test_dirs::child_process_gate();
        let bun = real_process::bun_binary()?;
        let marker = format!("backend-057-{}", uuid::Uuid::new_v4());
        let reply = json!({"terminals":[{"marker": marker}]});
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let api_port = listener.local_addr().unwrap().port();
        let app = axum::Router::new().route(
            "/api/fleet/terminals",
            axum::routing::get(move || {
                let reply = reply.clone();
                async move { axum::Json(reply) }
            }),
        );
        let backend = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Some(Self {
            hosts: vec![],
            bin,
            bun,
            token: format!("host-{}", uuid::Uuid::new_v4()),
            bearer: format!("bearer-{}", uuid::Uuid::new_v4()),
            marker,
            api_port,
            backend,
            _gate: gate,
        })
    }
    pub fn host(&mut self) -> usize {
        self.hosts.push(RealHost::spawn(&self.bin, &self.token));
        self.hosts.len() - 1
    }
    pub async fn sidecar(&self, port: u16, bind: &str, id: &str) -> Sidecar {
        let mut selected = port;
        for attempt in 0..2 {
            let mut s = Sidecar::spawn(
                &self.bun,
                self.api_port,
                selected,
                bind,
                Some(&self.bearer),
                id,
            );
            match s.try_wait_listening(selected, id).await {
                Ok(()) => return s,
                Err(error) if attempt == 0 && error.contains("EADDRINUSE") => {
                    eprintln!("setup lost port race on {selected}; retrying setup once: {error}");
                    selected = free_port(bind);
                }
                Err(error) => panic!("sidecar setup failed (no after-setup skip): {error}"),
            }
        }
        unreachable!()
    }
    pub fn config(&self, port: u16, bind: &str) -> NetworkConfig {
        NetworkConfig {
            mcp_port: port,
            api_port: self.api_port,
            expose_on_network: bind == "0.0.0.0",
            auth_token: self.bearer.clone(),
        }
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        self.backend.abort();
    }
}

pub(super) struct Sidecar {
    pub child: OwnedChild,
    pub port: u16,
    _dir: TestDir,
}
impl Sidecar {
    pub fn spawn(
        bun: &std::path::Path,
        api: u16,
        port: u16,
        bind: &str,
        bearer: Option<&str>,
        id: &str,
    ) -> Self {
        let dir = TestDir::new();
        let log = real_process::guard_path(&dir.path().join("sidecar.log"), Some(dir.path()));
        let log = std::fs::File::create(log).unwrap();
        let child = Command::new(bun)
            .arg("mcp-server/src/index.ts")
            .current_dir(real_process::repo())
            .env("MCP_PORT", port.to_string())
            .env("MCP_HOST", bind)
            .env("AUTO_TERMINAL_API_URL", format!("http://127.0.0.1:{api}"))
            .env("AUTO_TERMINAL_TOKEN", bearer.unwrap_or(""))
            .env("AUTO_TERMINAL_API_TOKEN", bearer.unwrap_or(""))
            .env("AUTO_TERMINAL_INSTANCE_ID", id)
            .env("MCP_PARENT_PID", std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .expect("owned Bun sidecar");
        Self {
            child: OwnedChild(child),
            port,
            _dir: dir,
        }
    }
    pub fn shutdown(&mut self) {
        self.child
            .0
            .stdin
            .as_mut()
            .expect("sidecar stdin")
            .write_all(b"TERMFLOW_SHUTDOWN\n")
            .unwrap();
    }
    pub async fn wait_listening(&mut self, port: u16, id: &str) {
        self.try_wait_listening(port, id)
            .await
            .expect("sidecar listening");
    }
    async fn try_wait_listening(&mut self, port: u16, id: &str) -> Result<(), String> {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(value) = health(port).await {
                if value["instanceId"] == id {
                    return Ok(());
                }
            }
            if self.child.0.try_wait().unwrap().is_some() {
                return Err(
                    std::fs::read_to_string(self._dir.path().join("sidecar.log"))
                        .unwrap_or_default(),
                );
            }
            if Instant::now() >= end {
                return Err("sidecar listening timeout / foreign identity".into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
pub(super) fn free_port(bind: &str) -> u16 {
    std::net::TcpListener::bind((bind, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
pub(super) async fn health(port: u16) -> Option<Value> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(250))
        .build()
        .unwrap()
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}
pub(super) async fn refuses(port: u16, within: Duration) {
    let end = Instant::now() + within;
    loop {
        // Windows may delay ECONNREFUSED beyond STOP_BOUND. An exclusive same-address
        // rebind is a stronger oracle than a connection timeout: no listener still owns P.
        if let Ok(listener) = std::net::TcpListener::bind(("0.0.0.0", port)) {
            drop(listener);
            return;
        }
        assert!(
            Instant::now() < end,
            "port {port} still accepts past stop bound"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[derive(Clone)]
pub(super) struct Agent {
    pub port: u16,
    pub bearer: Option<String>,
    pub session: Option<String>,
    client: reqwest::Client,
}
pub(super) struct Reply {
    pub status: u16,
    pub value: Value,
    pub raw: String,
    pub session: Option<String>,
}
impl Reply {
    pub fn result_bytes(&self) -> &str {
        super::super::mcp_snapshot::raw_member(&self.raw, "result").expect("raw result")
    }
    pub fn text(&self) -> &str {
        self.value["result"]["content"][0]["text"]
            .as_str()
            .expect("tool text")
    }
}
impl Agent {
    pub fn new(port: u16, bearer: Option<&str>) -> Self {
        Self {
            port,
            bearer: bearer.map(str::to_owned),
            session: None,
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
        }
    }
    pub fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        let mut r = self
            .client
            .request(method, format!("http://127.0.0.1:{}/mcp", self.port))
            .header("Accept", "application/json, text/event-stream")
            .header(
                "MCP-Protocol-Version",
                super::super::mcp_snapshot::MCP_PROTOCOL_VERSION,
            );
        if let Some(b) = &self.bearer {
            r = r.bearer_auth(b);
        }
        if let Some(s) = &self.session {
            r = r.header("mcp-session-id", s);
        }
        r
    }
    pub async fn post(&self, method: &str, params: Value) -> Result<Reply, reqwest::Error> {
        let r = self
            .request(reqwest::Method::POST)
            .json(&json!({"jsonrpc":"2.0","id":71,"method":method,"params":params}))
            .send()
            .await?;
        let status = r.status().as_u16();
        let session = r
            .headers()
            .get("mcp-session-id")
            .and_then(|s| s.to_str().ok())
            .map(str::to_owned);
        let body = r.text().await?;
        let raw = if body.starts_with("event:") || body.starts_with("data:") {
            body.lines()
                .find_map(|l| l.strip_prefix("data: "))
                .unwrap_or(&body)
                .to_string()
        } else {
            body
        };
        let value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        Ok(Reply {
            status,
            value,
            raw,
            session,
        })
    }
    pub async fn initialize(&mut self) -> Reply {
        self.session = None;
        let r = self.post("initialize", json!({"protocolVersion":super::super::mcp_snapshot::MCP_PROTOCOL_VERSION,
            "capabilities":{},"clientInfo":{"name":"termflow-handover","version":env!("CARGO_PKG_VERSION")}})).await.unwrap();
        assert_eq!(r.status, 200);
        self.session = r.session.clone();
        assert!(self.session.is_some());
        let response = self
            .request(reqwest::Method::POST)
            .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 202);
        r
    }
    pub async fn call(&self) -> Result<Reply, reqwest::Error> {
        self.post(
            "tools/call",
            json!({"name":"list_terminals","arguments":{}}),
        )
        .await
    }
    pub async fn sse(&self) -> Sse {
        // No client-wide timeout on SSE: each read has its own bound.
        let mut r = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{}/mcp", self.port))
            .header("Accept", "text/event-stream")
            .header("mcp-session-id", self.session.as_ref().unwrap());
        if let Some(b) = &self.bearer {
            r = r.bearer_auth(b);
        }
        let response = tokio::time::timeout(Duration::from_secs(2), r.send())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        Sse {
            response,
            bytes: vec![],
        }
    }
}
pub(super) struct Sse {
    response: reqwest::Response,
    bytes: Vec<u8>,
}
impl Sse {
    pub async fn contains(&mut self, needle: &str, within: Duration) {
        let end = Instant::now() + within;
        while !String::from_utf8_lossy(&self.bytes).contains(needle) {
            let chunk = tokio::time::timeout_at(end, self.response.chunk())
                .await
                .expect("bounded SSE heartbeat")
                .unwrap()
                .expect("SSE must not end before heartbeat");
            self.bytes.extend_from_slice(&chunk);
        }
    }
    pub async fn eof(&mut self, within: Duration) {
        let end = Instant::now() + within;
        loop {
            match tokio::time::timeout_at(end, self.response.chunk())
                .await
                .expect("bounded SSE EOF")
            {
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return,
            }
        }
    }
}
