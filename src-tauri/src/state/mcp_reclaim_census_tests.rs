//! Source censuses for the MCP reclaim (plan 056 T3, T5, T8): the statements that must be live in
//! production code, proved on masked text by [`super::live_call_census`], each with the planted
//! mutations it has to kill. A negative case edits the real source text, asserts the edit took
//! effect, and requires the census to fail.
//!
//! What is pinned, and what is not:
//! - `settle`'s awaited work block, `reclaim_claim`, `settle_ctx` and the two `settle` call sites in
//!   `adopt`; the routes into `settle` are covered by the behavioural tests, not by this census.
//! - The boot task's statements in `lib.rs` and their order, and every delegation of the real boot IO.
//!   The sequence's behaviour is proven by the fake-IO tests (`mcp_boot_tests`), not by this census.
//! - The callers of each reclaim entry point.

use super::live_call_census::{find_calls, Block, Kind, Src, Sub};
use super::mcp_hold_census_tests::{mutate, norm, production_sources};

const HOST_ADOPTION: &str = include_str!("host_adoption.rs");
const LIB: &str = include_str!("../lib.rs");
const RECLAIM: &str = include_str!("mcp_reclaim.rs");

// ---- T3: the claim in settle ------------------------------------------------------------------------

const GATE: &str = "if client.mcp_hold() { reclaim_claim(client, ctx).await; }";
const CLAIM_CALL: &str = "client.claim_mcp(&ctx.token)";
const OFFER: &str = "ctx.reclaim.offer(Claimed::new(held, client.clone(), ctx.channel, ctx.epoch, ctx.endpoint.clone(), ctx.token.clone()));";
const SETTLE_CTX_BODY: &str = "SettleCtx { channel, epoch, endpoint: endpoint.to_owned(), token: port.host_token(), reclaim: port.reclaim().clone() }";
const EXISTING_SITE: &str = "let listing = settle(&client, &settle_ctx(port, channel, epoch, &candidate.endpoint), deadline).await;";
const RESERVED_EPOCH: &str = "let reserved = frozen.map_or(opened.epoch, |(_, epoch)| epoch);";
const NEW_SITE: &str = "let listing = settle(&client, &settle_ctx(port, channel, reserved, &candidate.endpoint), deadline).await;";

/// The `async { .. }` block `settle` binds to `work`.
fn work_block(src: &Src, body: &Block) -> Result<Block, String> {
    let stmt = body
        .stmts
        .iter()
        .find(|s| src.norm(&s.span).starts_with("letwork=async{"))
        .ok_or("settle no longer binds `let work = async {`")?;
    stmt.subs
        .iter()
        .find_map(|sub| match sub {
            Sub::Block(block) if block.kind == Kind::Async => Some(block.clone()),
            _ => None,
        })
        .ok_or_else(|| "settle's work is not an async block".to_string())
}

fn check_settle(text: &str) -> Result<(), String> {
    let src = Src::production(text);
    let body = src.try_function("async fn settle(")?;
    let work = work_block(&src, &body)?;

    // The work block runs: it is awaited under the deadline, as the function's own result.
    let tail = body.stmts.last().map(|s| src.norm(&s.span)).unwrap_or_default();
    if tail != "tokio::time::timeout_at(deadline,work).await.unwrap_or(None)" {
        return Err(format!("settle no longer awaits its work block under the deadline: {tail}"));
    }

    // The gate is the work block's first statement, exactly the pinned text.
    let first = work.stmts.first().ok_or("settle's work block is empty")?;
    let first_text = src.norm(&first.span);
    if first_text != norm(GATE) {
        return Err(format!("settle's work block no longer begins with the capability gate: {first_text}"));
    }
    // Inside the gate the claim is one unconditional, awaited statement.
    let gate_block = first
        .subs
        .iter()
        .find_map(|sub| match sub {
            Sub::Block(block) if block.kind == Kind::If => Some(block),
            _ => None,
        })
        .ok_or("the gate has no block")?;
    let claims: Vec<_> =
        gate_block.stmts.iter().filter(|s| src.norm(&s.span) == "reclaim_claim(client,ctx).await;").collect();
    if gate_block.stmts.len() != 1 || claims.len() != 1 || !gate_block.is_unconditional(&claims[0].span) {
        return Err("the gate must hold exactly one unconditional `reclaim_claim(client, ctx).await;`".into());
    }

    // The claim comes before the Disarm, which is a statement of the same block.
    let disarm = work
        .stmts
        .iter()
        .position(|s| src.norm(&s.span).starts_with("if!client.disarm().await{"))
        .ok_or("settle's work block lost its `client.disarm()` statement")?;
    if disarm == 0 {
        return Err("the Disarm precedes the claim".into());
    }

    let function = body.open..body.close + 1;
    if find_calls(&src.masked[function.clone()], "reclaim_claim(").len() != 1 {
        return Err("settle must call reclaim_claim exactly once".into());
    }
    if find_calls(&src.masked[function], "client.disarm(").len() != 1 {
        return Err("settle must disarm exactly once".into());
    }
    if find_calls(&src.masked, "reclaim_claim(").len() != 2 {
        return Err("reclaim_claim must be defined once and called once".into());
    }
    Ok(())
}

fn check_reclaim_claim(text: &str) -> Result<(), String> {
    let src = Src::production(text);
    let body = src.try_function("async fn reclaim_claim(")?;
    let [matched] = &body.stmts[..] else {
        return Err("reclaim_claim is no longer one match".into());
    };
    if !src.norm(&matched.span).starts_with(&format!("match{}.await{{", norm(CLAIM_CALL))) {
        return Err(format!("reclaim_claim no longer matches on `{CLAIM_CALL}.await`"));
    }
    let offers: Vec<_> = body.all_stmts().into_iter().filter(|s| src.norm(&s.span) == norm(OFFER)).collect();
    let [offer] = &offers[..] else {
        return Err(format!("reclaim_claim must contain exactly one `{OFFER}`, found {}", offers.len()));
    };
    let chain = body.constructs_at(offer.span.start);
    let expected = Kind::MatchArm(String::new());
    match chain.as_slice() {
        [Kind::MatchArm(pattern)] if pattern.chars().filter(|c| !c.is_whitespace()).collect::<String>() == "Ok(McpClaimOutcome::Held(Some(held)))" => {}
        other => return Err(format!("the offer must be exactly the `Held(Some(held))` arm, found {other:?} (not {expected:?})")),
    }
    if src.masked.matches(".claim_mcp(").count() != 1 {
        return Err("host_adoption.rs must contain exactly one `.claim_mcp(`".into());
    }
    Ok(())
}

fn check_settle_ctx_and_sites(text: &str) -> Result<(), String> {
    let src = Src::production(text);
    let ctx = src.try_function("fn settle_ctx<P: AdoptionPort>(")?;
    let body = src.norm(&(ctx.open + 1..ctx.close));
    if body != norm(SETTLE_CTX_BODY) {
        return Err(format!("settle_ctx's body changed: {body}"));
    }
    let adopt = src.try_function("async fn adopt<P: AdoptionPort>(")?;
    let all = adopt.all_stmts();
    for site in [EXISTING_SITE, RESERVED_EPOCH, NEW_SITE] {
        let hits = all.iter().filter(|s| src.norm(&s.span) == norm(site)).count();
        if hits != 1 {
            return Err(format!("adopt must contain exactly one `{site}`, found {hits}"));
        }
    }
    if find_calls(&src.masked[adopt.open..adopt.close], "settle(").len() != 2 {
        return Err("adopt must call settle exactly twice".into());
    }
    Ok(())
}

fn check_claim_wiring(text: &str) -> Result<(), String> {
    check_settle(text)?;
    check_reclaim_claim(text)?;
    check_settle_ctx_and_sites(text)
}

#[test]
fn settle_claims_before_disarm_in_its_awaited_work_block() {
    check_claim_wiring(HOST_ADOPTION).unwrap();
}

#[test]
fn the_claim_census_kills_each_planted_mutation() {
    let disarm_loop = "        for attempt in 0..LIST_ATTEMPTS {";
    let without_gate = mutate(HOST_ADOPTION, &format!("        {GATE}\n"), "");
    let cases: Vec<(&str, String)> = vec![
        ("the gate after the disarm", mutate(&without_gate, disarm_loop, &format!("        {GATE}\n{disarm_loop}"))),
        ("the claim moved out of the gate", mutate(HOST_ADOPTION, GATE, "reclaim_claim(client, ctx).await;")),
        ("a second, dead gate", mutate(HOST_ADOPTION, GATE, &format!("if false {{ reclaim_claim(client, ctx).await; }}\n        {GATE}"))),
        ("the claim in an unawaited closure", mutate(HOST_ADOPTION, GATE, "if client.mcp_hold() { let _claim = || reclaim_claim(client, ctx); }")),
        ("the claim not awaited", mutate(HOST_ADOPTION, GATE, "if client.mcp_hold() { let _claim = reclaim_claim(client, ctx); }")),
        ("the gate negated", mutate(HOST_ADOPTION, GATE, "if !client.mcp_hold() { reclaim_claim(client, ctx).await; }")),
        ("the gate on the wrong client", mutate(HOST_ADOPTION, GATE, "if other.mcp_hold() { reclaim_claim(client, ctx).await; }")),
        ("the gate removed", without_gate.clone()),
        ("the claim inside an `if false`", mutate(HOST_ADOPTION, GATE, "if client.mcp_hold() { if false { reclaim_claim(client, ctx).await; } }")),
        ("the token replaced by the sidecar bearer", mutate(HOST_ADOPTION, CLAIM_CALL, "client.claim_mcp(&sidecar_bearer)")),
        ("the offer removed", mutate(HOST_ADOPTION, OFFER, "")),
        ("the offer behind an `if false`", mutate(HOST_ADOPTION, OFFER, &format!("if false {{ {OFFER} }}"))),
        ("the offer outside the held arm", mutate(HOST_ADOPTION, OFFER, "")
            .replacen("Ok(McpClaimOutcome::Held(None)) =>", &format!("Ok(McpClaimOutcome::Held(None)) => {{ {OFFER} }} _ if false =>"), 1)),
        ("a work block not awaited under the deadline", mutate(HOST_ADOPTION, "tokio::time::timeout_at(deadline, work).await.unwrap_or(None)", "let _ = work; None")),
        ("a ctx token from the sidecar", mutate(HOST_ADOPTION, "token: port.host_token(), reclaim:", "token: String::from(\"bearer\"), reclaim:")),
        ("the re-list site claiming with another epoch", mutate(HOST_ADOPTION, EXISTING_SITE, "let listing = settle(&client, &settle_ctx(port, channel, 0, &candidate.endpoint), deadline).await;")),
        ("the new-connection site claiming with the published epoch", mutate(HOST_ADOPTION, NEW_SITE, "let listing = settle(&client, &settle_ctx(port, channel, opened.epoch, &candidate.endpoint), deadline).await;")),
        ("a third settle call in adopt", mutate(HOST_ADOPTION, RESERVED_EPOCH, &format!("{RESERVED_EPOCH}\n    let _extra = settle(&client, &settle_ctx(port, channel, reserved, &candidate.endpoint), deadline).await;"))),
    ];
    for (name, source) in cases {
        let verdict = check_claim_wiring(&source);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}

// ---- T5: the boot task in lib.rs -----------------------------------------------------------------------

const ANCHOR: &str = "let _op = api_state.network_op_lock.lock().await;";
const MCP_IO: &str = "let mcp_io = crate::state::mcp_reclaim::AppBootIo { app: mcp_app_handle, state: api_state.clone() };";
const PREPARE: &str = "let prepared = crate::state::mcp_reclaim::prepare_reclaim(&mcp_io, crate::state::mcp_reclaim::BootInputs { own_id: api_state.instance_id.clone(), cfg: mcp_net, reclaim: api_state.mcp_reclaim.clone(), },).await;";
const BIND: &str = "let picked = crate::net_ports::bind_api_listener(host, api_net.api_port, crate::net_ports::DEFAULT_SPAN, &api_state.instance_id, prepared.reserved(),).await;";
const API_PUBLISH: &str = "api_state.effective_endpoints.write().api_port = Some(api_port);";
const START: &str = "let mcp_effective_port = crate::state::mcp_reclaim::start_mcp(prepared, api_port, &mcp_io).await;";
const MCP_PUBLISH: &str = "api_state.effective_endpoints.write().mcp_port = mcp_effective_port;";
const SERVE: &str = "crate::api_server::start_api_server(api_state, listener, api_net.expose_on_network, api_sd_rx,).await;";
const DROP_PREPARED: &str = "drop(prepared);";

/// Where each statement is and how it is guarded, in the order the boot task must run them.
fn check_boot_task(text: &str) -> Result<(), String> {
    let src = Src::production(text);
    let run = src.try_function("pub fn run(")?;
    let all = run.all_stmts();
    let find = |wanted: &str| -> Result<&crate::state::live_call_census::Stmt, String> {
        let hits: Vec<_> = all.iter().filter(|s| src.norm(&s.span) == norm(wanted)).collect();
        match hits[..] {
            [one] => Ok(one),
            _ => Err(format!("`{wanted}` must be exactly one statement of the boot task, found {}", hits.len())),
        }
    };
    let anchor = find(ANCHOR)?;
    let base = run.constructs_at(anchor.span.start);
    // Each statement runs exactly when the boot task does (same guards as the lock), or, for the
    // ones after the bind, exactly in the `Some(Picked ..)` arm of its match.
    let mut previous = anchor.span.start;
    for (statement, in_arm) in [
        (MCP_IO, false),
        (PREPARE, false),
        (BIND, false),
        (API_PUBLISH, true),
        (START, true),
        (MCP_PUBLISH, true),
        (SERVE, true),
    ] {
        let stmt = find(statement)?;
        let chain = run.constructs_at(stmt.span.start);
        let live = if in_arm {
            chain.len() == base.len() + 1
                && chain[..base.len()] == base[..]
                && matches!(&chain[base.len()], Kind::MatchArm(pattern) if norm(pattern).starts_with("Some(crate::net_ports::Picked"))
        } else {
            chain == base
        };
        if !live {
            return Err(format!("`{statement}` is not live in the boot task: {chain:?} (boot task: {base:?})"));
        }
        if stmt.span.start <= previous {
            return Err(format!("`{statement}` is out of order in the boot task"));
        }
        previous = stmt.span.start;
    }
    // The record publishes the effective ports, from the values the boot task computed.
    let publish: Vec<_> =
        all.iter().filter(|s| src.norm(&s.span).starts_with("ifletErr(e)=crate::net_ports::publish(&crate::net_ports::InstanceRecord{")).collect();
    let [publish] = &publish[..] else { return Err("the instance record publication is not one statement".into()) };
    let published = src.norm(&publish.span);
    if !published.contains("api_port:Some(api_port),mcp_port:mcp_effective_port,") || published.contains("api_net.mcp_port") {
        return Err(format!("the instance record is not built from the effective ports: {published}"));
    }
    if publish.span.start < find(MCP_PUBLISH)?.span.start || publish.span.start > find(SERVE)?.span.start {
        return Err("the instance record is not published between the MCP publication and serving".into());
    }
    // The failed-bind arm hands the claim back before anything else.
    let none_arm = all.iter().filter(|s| src.norm(&s.span) == norm(DROP_PREPARED)).count();
    if none_arm != 1 {
        return Err(format!("the bind-failure arm must drop `prepared` exactly once, found {none_arm}"));
    }
    let drop_at = find(DROP_PREPARED)?.span.start;
    if !matches!(run.constructs_at(drop_at).last(), Some(Kind::MatchArm(pattern)) if norm(pattern) == "None") {
        return Err("`drop(prepared);` is not in the `None` arm of the bind".into());
    }
    // The listener is only ever handed to serving.
    if !find_calls(&src.masked[run.open..run.close], "drop(listener)").is_empty() {
        return Err("the listener is dropped".into());
    }
    // The boot task no longer searches or spawns by itself.
    for direct in ["pick_mcp_port(", "respawn_mcp("] {
        if !find_calls(&src.masked, direct).is_empty() {
            return Err(format!("lib.rs calls `{direct}` directly"));
        }
    }
    Ok(())
}

#[test]
fn the_boot_task_runs_the_reclaim_phases_around_the_api_bind_in_order() {
    check_boot_task(LIB).unwrap();
}

#[test]
fn the_boot_task_census_kills_each_planted_mutation() {
    let swap = |a: &str, b: &str| {
        let cut = mutate(LIB, a, "@@A@@");
        let cut = mutate(&cut, b, a);
        mutate(&cut, "@@A@@", b)
    };
    let cases: Vec<(&str, String)> = vec![
        ("the API publication moved after start_mcp", swap(API_PUBLISH, START)),
        ("reserved dropped from the bind", mutate(LIB, "prepared.reserved(),", "&[],")),
        ("BootInputs built from the default config", mutate(LIB, "cfg: mcp_net,", "cfg: crate::app_config::NetworkConfig::defaults(),")),
        ("a second registry", mutate(LIB, "reclaim: api_state.mcp_reclaim.clone(),", "reclaim: crate::state::McpReclaim::new(),")),
        ("BootInputs with another identity", mutate(LIB, "own_id: api_state.instance_id.clone(),", "own_id: String::new(),")),
        ("the record's mcp_port from the configuration", mutate(LIB, "mcp_port: mcp_effective_port,", "mcp_port: Some(api_net.mcp_port),")),
        ("the record's api_port from the configuration", mutate(LIB, "api_port: Some(api_port),\n                            mcp_port", "api_port: Some(api_net.api_port),\n                            mcp_port")),
        ("the listener dropped before serving", mutate(LIB, SERVE.split('(').next().unwrap(), &format!("drop(listener);\n                    {}", SERVE.split('(').next().unwrap()))),
        ("a direct pick_mcp_port call", mutate(LIB, START, &format!("{START}\n                    let _p = crate::net_ports::pick_mcp_port(1, 1, \"x\", &[]).await;"))),
        ("a direct respawn_mcp call", mutate(LIB, START, &format!("{START}\n                    let _r = respawn_mcp(mcp_app_handle2, api_state.clone(), &cfg2).await;"))),
        ("start_mcp skipped", mutate(LIB, START, "let mcp_effective_port: Option<u16> = None;")),
        ("start_mcp behind an `if false`", mutate(LIB, START, "let mcp_effective_port = if false { None } else { crate::state::mcp_reclaim::start_mcp(prepared, api_port, &mcp_io).await };")),
        ("start_mcp given another io", mutate(LIB, "start_mcp(prepared, api_port, &mcp_io)", "start_mcp(prepared, api_port, &other_io)")),
        ("prepare skipped", mutate(LIB, "let prepared = crate::state::mcp_reclaim::prepare_reclaim(", "let prepared = crate::state::mcp_reclaim::prepare_nothing(")),
        ("the failed-bind arm keeps the claim", mutate(LIB, "                    drop(prepared);\n", "")),
        ("the API publication behind an `if false`", mutate(LIB, API_PUBLISH, &format!("if false {{ {API_PUBLISH} }}"))),
        ("the MCP publication from the configuration", mutate(LIB, MCP_PUBLISH, "api_state.effective_endpoints.write().mcp_port = Some(api_net.mcp_port);")),
    ];
    for (name, source) in cases {
        let verdict = check_boot_task(&source);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}

// ---- T5: the real boot IO ---------------------------------------------------------------------------------------

const ADAPTER: [(&str, &str); 6] = [
    ("fn start_round(", "tokio::spawn(survivor_round(self.state.clone()))"),
    ("fn quiet(", "!self.state.host_barrier.any_in_flight()"),
    (
        "async fn pick_mcp(",
        "crate::net_ports::pick_mcp_port(cfg.mcp_port, crate::net_ports::DEFAULT_SPAN, own_id, &[api_port]).await",
    ),
    (
        "async fn spawn(",
        "crate::respawn_mcp(self.app.clone(), self.state.clone(), &NetworkConfig { mcp_port: port, ..cfg.clone() }).await",
    ),
    ("async fn owns(", "crate::network_commands::probe_port_owner(port, own_id).await"),
    ("fn stop(", "crate::shutdown_mcp_server(&self.state);"),
];

fn check_adapter(text: &str) -> Result<(), String> {
    let src = Src::production(text);
    let impl_range = src.braced_after("impl McpBootIo for AppBootIo");
    let adapter = Src::new(&src.code[impl_range]);
    for (signature, expected) in ADAPTER {
        let body = adapter.try_function(signature)?;
        let got = adapter.norm(&(body.open + 1..body.close));
        if got != norm(expected) {
            return Err(format!("`{signature}` is not the pinned delegation: {got}"));
        }
    }
    let round = src.try_function("async fn survivor_round(")?;
    let [stmt] = &round.stmts[..] else { return Err("survivor_round is no longer one statement".into()) };
    if !src.norm(&stmt.span).starts_with("ifletErr(e)=state.adopt_survivors().await{") {
        return Err("survivor_round no longer awaits adopt_survivors".into());
    }
    // The guard is the first thing prepare_reclaim makes.
    let prepare = src.try_function("pub(crate) async fn prepare_reclaim<IO: McpBootIo>(")?;
    let first = prepare.stmts.first().map(|s| src.norm(&s.span)).unwrap_or_default();
    if first != norm("let mut guard = ReclaimBoot::new(inputs.reclaim.clone());") {
        return Err(format!("prepare_reclaim does not begin with the boot guard: {first}"));
    }
    if find_calls(&src.masked, "ReclaimBoot::new(").len() != 1 {
        return Err("exactly one ReclaimBoot is made in production".into());
    }
    Ok(())
}

#[test]
fn the_real_boot_io_is_a_set_of_pinned_delegations() {
    check_adapter(RECLAIM).unwrap();
}

#[test]
fn the_adapter_census_kills_each_planted_mutation() {
    let (spawn_body, owns_body, pick_body) = (ADAPTER[3].1, ADAPTER[4].1, ADAPTER[2].1);
    let cases: Vec<(&str, String)> = vec![
        ("spawn passing the configured port", mutate(RECLAIM, spawn_body, "crate::respawn_mcp(self.app.clone(), self.state.clone(), cfg).await")),
        ("spawn passing the wrong port", mutate(RECLAIM, "NetworkConfig { mcp_port: port, ..cfg.clone() }", "NetworkConfig { mcp_port: cfg.mcp_port, ..cfg.clone() }")),
        ("owns probing the configured port", mutate(RECLAIM, owns_body, "crate::network_commands::probe_port_owner(cfg_port(), own_id).await")),
        ("owns probing another id", mutate(RECLAIM, owns_body, "crate::network_commands::probe_port_owner(port, \"other\").await")),
        ("pick searching from the held port", mutate(RECLAIM, pick_body, "crate::net_ports::pick_mcp_port(api_port, crate::net_ports::DEFAULT_SPAN, own_id, &[api_port]).await")),
        ("pick not reserving the API port", mutate(RECLAIM, "own_id, &[api_port]).await", "own_id, &[]).await")),
        ("quiet ignoring the barrier", mutate(RECLAIM, ADAPTER[1].1, "true")),
        ("stop doing nothing", mutate(RECLAIM, ADAPTER[5].1, "")),
        ("start_round starting no round", mutate(RECLAIM, ADAPTER[0].1, "tokio::spawn(async {})")),
        ("the survivor round never adopting", mutate(RECLAIM, "if let Err(e) = state.adopt_survivors().await {", "if let Err(e) = Ok::<(), String>(()) {")),
        ("the guard made after the round starts", mutate(RECLAIM, "    let mut guard = ReclaimBoot::new(inputs.reclaim.clone());\n    let BootInputs { own_id, cfg, reclaim } = inputs;\n    let mut round = io.start_round();", "    let mut round = io.start_round();\n    let mut guard = ReclaimBoot::new(inputs.reclaim.clone());\n    let BootInputs { own_id, cfg, reclaim } = inputs;")),
    ];
    for (name, source) in cases {
        let verdict = check_adapter(&source);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}

// ---- T8: who calls what -------------------------------------------------------------------------------------------

/// `(relative path, live occurrences)` of `needle` in production code.
fn callers(files: &[(String, String)], needle: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    for (name, text) in files {
        let masked = Src::production(text).masked;
        // A method call is `.name(` after a receiver, so it has no word boundary before the dot.
        let hits = if needle.starts_with('.') { masked.matches(needle).count() } else { find_calls(&masked, needle).len() };
        if hits > 0 {
            out.push((name.clone(), hits));
        }
    }
    out.sort();
    out
}

fn files() -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    production_sources()
        .into_iter()
        .map(|(path, text)| (path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"), text))
        .collect()
}

fn check_callers(files: &[(String, String)]) -> Result<(), String> {
    let expected: [(&str, &[(&str, usize)]); 10] = [
        (".claim_mcp(", &[("state/host_adoption.rs", 1)]),
        ("reclaim_claim(", &[("state/host_adoption.rs", 2)]),
        (".offer(", &[("state/host_adoption.rs", 1)]),
        ("ReclaimBoot::new(", &[("state/mcp_reclaim.rs", 1)]),
        (".lease_on(", &[("state/host_retire.rs", 1)]),
        ("prepare_reclaim(", &[("lib.rs", 1)]),
        ("start_mcp(", &[("lib.rs", 1)]),
        (".adopt_survivors(", &[("state/mcp_reclaim.rs", 1)]),
        ("host_adoption::adopt_survivors(", &[("state/terminals.rs", 1)]),
        ("bind_api_listener(", &[("lib.rs", 1), ("net_ports.rs", 1), ("network_commands.rs", 1)]),
    ];
    for (needle, want) in expected {
        let got = callers(files, needle);
        let want: Vec<(String, usize)> = want.iter().map(|(n, c)| (n.to_string(), *c)).collect();
        if got != want {
            return Err(format!("`{needle}` is used by {got:?}, expected {want:?}"));
        }
    }
    Ok(())
}

#[test]
fn every_reclaim_entry_point_has_exactly_its_callers() {
    check_callers(&files()).unwrap();
}

#[test]
fn the_caller_census_kills_each_planted_mutation() {
    let real = files();
    let with = |name: &str, extra: &str| -> Vec<(String, String)> {
        let mut files = real.clone();
        match files.iter_mut().find(|(n, _)| n == name) {
            Some((_, text)) => text.push_str(extra),
            None => files.push((name.to_string(), extra.to_string())),
        }
        files
    };
    let cases: Vec<(&str, Vec<(String, String)>)> = vec![
        ("a second claim site", with("state/host_lifecycle.rs", "\nasync fn leak(c: &PtyHostClient) { let _ = c.claim_mcp(\"t\").await; }\n")),
        ("a second offer site", with("state/host_port.rs", "\nfn leak(r: &McpReclaim, c: Claimed) { r.offer(c); }\n")),
        ("a second lease reader", with("state/host_routing.rs", "\nfn leak(r: &McpReclaim) -> bool { r.lease_on(c, 1) }\n")),
        ("a second boot guard", with("lib.rs", "\nfn leak(r: McpReclaim) { let _g = ReclaimBoot::new(r); }\n")),
        ("a second prepare", with("commands/update.rs", "\nasync fn leak(io: &I) { let _ = prepare_reclaim(io, inputs).await; }\n")),
        ("a second start", with("network_commands.rs", "\nasync fn leak(io: &I) { let _ = start_mcp(p, 1, io).await; }\n")),
        ("a second survivor round", with("state/host_routing.rs", "\nasync fn leak(s: &AppState) { let _ = s.adopt_survivors().await; }\n")),
        ("a third API bind", with("commands/network.rs", "\nasync fn leak() { let _ = bind_api_listener(h, 1, 1, \"x\", &[]).await; }\n")),
        ("the claim site lost", real.iter().map(|(n, t)| if n == "state/host_adoption.rs" { (n.clone(), t.replacen(".claim_mcp(", ".claim_other(", 1)) } else { (n.clone(), t.clone()) }).collect()),
    ];
    for (name, files) in cases {
        let verdict = check_callers(&files);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}
