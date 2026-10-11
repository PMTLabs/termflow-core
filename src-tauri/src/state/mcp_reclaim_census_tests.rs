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
const DISARM: &str = "if !client.disarm().await { log::warn!(\"[GEN] host did not acknowledge the disarm\"); }";
const CLAIM_CALL: &str = "client.claim_mcp(&ctx.token)";
const OFFER: &str = "ctx.reclaim.offer(Claimed::new(held, client.clone(), ctx.channel, ctx.epoch, ctx.endpoint.clone(), ctx.token.clone()));";
const SETTLE_CTX_BODY: &str = "SettleCtx { channel, epoch, endpoint: endpoint.to_owned(), token: port.host_token(), reclaim: port.reclaim().clone() }";
const EXISTING_SITE: &str = "let listing = settle(&client, &settle_ctx(port, channel, epoch, &candidate.endpoint), deadline).await;";
const RESERVED_EPOCH: &str = "let reserved = frozen.map_or(opened.epoch, |(_, epoch)| epoch);";
/// The branch the re-list site lives in, directly in `adopt`'s body.
const EXISTING_BRANCH: &str = "ifletSome((channel,client))=existing{";
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

    // The work block runs: `settle` is exactly its declaration and then its awaited result, so nothing
    // can depart before either (review 319 I5).
    let [declaration, tail] = &body.stmts[..] else {
        return Err(format!("settle must be exactly `let work = async {{ .. }};` and its awaited result, found {} statements", body.stmts.len()));
    };
    if !src.norm(&declaration.span).starts_with("letwork=async{") || !body.constructs_at(declaration.span.start).is_empty() {
        return Err("settle's first statement is not a live `let work = async {`".into());
    }
    let tail_text = src.norm(&tail.span);
    if tail_text != "tokio::time::timeout_at(deadline,work).await.unwrap_or(None)" || !body.constructs_at(tail.span.start).is_empty() {
        return Err(format!("settle no longer awaits its work block under the deadline: {tail_text}"));
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

    // The Disarm is the work block's second statement, whole: directly after the gate, with nothing that
    // could depart between them, in the work block itself.
    let second = work.stmts.get(1).ok_or("settle's work block lost its `client.disarm()` statement")?;
    if src.norm(&second.span) != norm(DISARM) || body.constructs_at(second.span.start) != [Kind::Async] {
        return Err(format!("the work block's second statement is not the live Disarm: {}", src.norm(&second.span)));
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
    // Each site runs on its own route: the re-list directly in the `existing` branch, the new connection's
    // epoch and claim unconditionally in `adopt`, in that order (review 318 I3).
    let mut previous = 0;
    for (site, route) in [(EXISTING_SITE, vec![Kind::If]), (RESERVED_EPOCH, vec![]), (NEW_SITE, vec![])] {
        let hits: Vec<_> = all.iter().filter(|s| src.norm(&s.span) == norm(site)).collect();
        let [stmt] = &hits[..] else {
            return Err(format!("adopt must contain exactly one `{site}`, found {}", hits.len()));
        };
        let chain = adopt.constructs_at(stmt.span.start);
        if chain != route {
            return Err(format!("`{site}` is not live on its route in adopt: {chain:?}, not {route:?}"));
        }
        if stmt.span.start <= previous {
            return Err(format!("`{site}` is out of order in adopt"));
        }
        previous = stmt.span.start;
    }
    let branches: Vec<_> = adopt.stmts.iter().filter(|s| src.norm(&s.span).starts_with(EXISTING_BRANCH)).collect();
    let [branch] = &branches[..] else {
        return Err(format!("adopt must branch once on `{EXISTING_BRANCH}`, found {}", branches.len()));
    };
    let relist = all.iter().find(|s| src.norm(&s.span) == norm(EXISTING_SITE)).expect("found above");
    if !(branch.span.start < relist.span.start && relist.span.end <= branch.span.end) {
        return Err("the re-list site is not in the `existing` branch".into());
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
        ("the new connection's claim only for capable hosts", mutate(HOST_ADOPTION, NEW_SITE, &format!("let listing = if client.mcp_hold() {{ {NEW_SITE} listing }} else {{ None }};"))),
        ("the re-list only for capable hosts", mutate(HOST_ADOPTION, EXISTING_SITE, &format!("let listing = if client.mcp_hold() {{ {EXISTING_SITE} listing }} else {{ None }};"))),
        ("the re-list site in another branch", mutate(HOST_ADOPTION, &format!("        {EXISTING_SITE}
"), "").replacen("    let client = opened.client;", &format!("    if frozen.is_none() {{ {EXISTING_SITE} }}
    let client = opened.client;"), 1)),
        ("the reserved epoch after the new site", mutate(HOST_ADOPTION, &format!("    {RESERVED_EPOCH}
"), "").replacen(NEW_SITE, &format!("{NEW_SITE}
    {RESERVED_EPOCH}"), 1)),
        ("settle returning before its work is declared", mutate(HOST_ADOPTION, "    let work = async {
        if client.mcp_hold()", "    if deadline > Instant::now() { return None; }
    let work = async {
        if client.mcp_hold()")),
        ("the work block returning between the claim and the Disarm", mutate(HOST_ADOPTION, &format!("        {GATE}
"), &format!("        {GATE}
        return None;
"))),
        ("the Disarm under a condition", mutate(HOST_ADOPTION, "        if !client.disarm().await {", "        if false {}
        if !client.disarm().await {")),
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
/// The instance record, published with the effective ports the boot task computed.
const RECORD: &str = "if let Err(e) = crate::net_ports::publish(&crate::net_ports::InstanceRecord { profile: crate::profile::current().key(), pid: std::process::id(), api_port: Some(api_port), mcp_port: mcp_effective_port, token: (crate::profile::current().integrity == crate::profile::Integrity::High).then(|| api_net.auth_token.clone()), }, crate::profile::current().integrity == crate::profile::Integrity::High,) { log::warn!(\"[NET] could not republish the instance record: {e}\"); }";
const SERVE: &str = "crate::api_server::start_api_server(api_state, listener, api_net.expose_on_network, api_sd_rx,).await;";
const DROP_PREPARED: &str = "drop(prepared);";
/// The bind's match and its two arms, whole: the subject, and each pattern with its bindings and no guard.
const BIND_MATCH: &str = "matchpicked{";
const SUCCESS_ARM: &str = "Some(crate::net_ports::Picked { port: api_port, bound: listener })";
const FAILURE_ARM: &str = "None";
/// Where the boot task's own statements sit: the `setup` closure, then the spawned `async move` block.
/// Established independently of any statement in it, so that a construct around the whole task (a
/// condition, an uncalled closure, an earlier `return`) is seen (review 318 N2).
const BOOT_SCOPE: [Kind; 2] = [Kind::Closure, Kind::Async];
/// The statement that runs the boot task, a direct statement of the `setup` closure.
const BOOT_SPAWN: &str = "tauri::async_runtime::spawn(asyncmove{";

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
    let base = BOOT_SCOPE.to_vec();
    let in_arm = |pattern: &str| {
        let mut chain = base.clone();
        chain.push(Kind::MatchArm(pattern.to_owned()));
        chain
    };
    // The task itself: the one `spawn(async move {` statement directly in the `setup` closure, which every
    // boot subject below must lie inside (review 319 R2: a scope of the right kinds is not this task).
    let setup = find_calls(&src.masked[run.open..run.close], ".setup(");
    let [setup] = &setup[..] else { return Err(format!("run must register exactly one `.setup(`, found {}", setup.len())) };
    let setup_at = run.open + setup;
    let spawns: Vec<_> = all
        .iter()
        .filter(|s| src.norm(&s.span).starts_with(BOOT_SPAWN) && s.span.start > setup_at)
        .filter(|s| run.constructs_at(s.span.start) == [Kind::Closure])
        .collect();
    let [boot] = &spawns[..] else {
        return Err(format!("the setup closure must spawn the boot task once, live, found {}", spawns.len()));
    };
    let in_task = |stmt: &crate::state::live_call_census::Stmt| boot.span.start < stmt.span.start && stmt.span.end <= boot.span.end;
    let anchor = find(ANCHOR)?;
    if !in_task(anchor) {
        return Err(format!("`{ANCHOR}` is not in the spawned boot task"));
    }
    if run.constructs_at(anchor.span.start) != base {
        return Err(format!("`{ANCHOR}` is not live in the boot task: {:?} (boot task: {base:?})", run.constructs_at(anchor.span.start)));
    }
    // The bind's result is matched once, directly in the boot task; the post-bind statements are in its
    // success arm and the claim's cleanup in its failure arm (review 318 N3).
    let matches: Vec<_> = all.iter().filter(|s| src.norm(&s.span).starts_with(BIND_MATCH)).collect();
    let [bind_match] = &matches[..] else {
        return Err(format!("the boot task must match the bind's result exactly once (`match picked {{`), found {}", matches.len()));
    };
    if run.constructs_at(bind_match.span.start) != base || !in_task(bind_match) {
        return Err("`match picked` is not live in the boot task".into());
    }
    let in_match = |stmt: &crate::state::live_call_census::Stmt| {
        bind_match.span.start < stmt.span.start && stmt.span.end <= bind_match.span.end
    };
    // Each statement runs exactly when the boot task does, or, after the bind, exactly in the success arm.
    let mut previous = anchor.span.start;
    for (statement, after_bind) in [
        (MCP_IO, false),
        (PREPARE, false),
        (BIND, false),
        (API_PUBLISH, true),
        (START, true),
        (MCP_PUBLISH, true),
        (RECORD, true),
        (SERVE, true),
    ] {
        let stmt = find(statement)?;
        let chain = run.constructs_at(stmt.span.start);
        let live = in_task(stmt) && if after_bind { chain == in_arm(SUCCESS_ARM) && in_match(stmt) } else { chain == base };
        if !live {
            return Err(format!("`{statement}` is not live in the boot task: {chain:?} (boot task: {base:?})"));
        }
        if stmt.span.start <= previous {
            return Err(format!("`{statement}` is out of order in the boot task"));
        }
        previous = stmt.span.start;
    }
    // The failed-bind arm hands the claim back.
    let drop_prepared = find(DROP_PREPARED)?;
    if run.constructs_at(drop_prepared.span.start) != in_arm(FAILURE_ARM) || !in_match(drop_prepared) {
        return Err(format!("`drop(prepared);` is not live in the `None` arm of the bind: {:?}", run.constructs_at(drop_prepared.span.start)));
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

/// `lib.rs` with the whole boot task, otherwise unchanged, enclosed in `before … after`.
fn wrap_boot_task(before: &str, after: &str) -> String {
    let head = "        tauri::async_runtime::spawn(async move {
            // Boot network initialization";
    let tail = "                }
            }
        });

        // Spawn the PTY Output Listener";
    let wrapped = mutate(LIB, head, &format!("        {before}{}", head.trim_start()));
    let end = "        });

        // Spawn the PTY Output Listener";
    mutate(&wrapped, tail, &tail.replacen(end, &format!("        }});{after}

        // Spawn the PTY Output Listener"), 1))
}

/// `lib.rs` with the instance record publication, otherwise unchanged, enclosed in `before … after`.
fn wrap_record(before: &str, after: &str) -> String {
    let head = "if let Err(e) = crate::net_ports::publish(\n                        &crate::net_ports::InstanceRecord {";
    let tail = "could not republish the instance record: {e}\");\n                    }";
    let wrapped = mutate(LIB, head, &format!("{before}{head}"));
    mutate(&wrapped, tail, &format!("{tail}{after}"))
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
        ("the record published only on a network launch", wrap_record("if api_net.expose_on_network { ", " }")),
        ("the record published only from an uncalled closure", wrap_record("let _later = || { ", " };")),
        ("the record with another token", mutate(LIB, ".then(|| api_net.auth_token.clone()),", ".then(String::new),")),
        ("the boot task built but never spawned", mutate(LIB, "        tauri::async_runtime::spawn(async move {
            // Boot network initialization", "        let _boot = async move {
            // Boot network initialization")
            .replacen("                }
            }
        });

        // Spawn the PTY Output Listener", "                }
            }
        };

        // Spawn the PTY Output Listener", 1)),
        ("the whole boot task under a condition", wrap_boot_task("if api_net.expose_on_network { ", " }")),
        ("the whole boot task in an uncalled closure", wrap_boot_task("let _later = || { ", " };")),
        ("the boot task's body after a return", mutate(LIB, "            let _op = api_state.network_op_lock.lock().await;", "            return;
            let _op = api_state.network_op_lock.lock().await;")),
        ("the success arm guarded, with a fallback arm", mutate(LIB, "Some(crate::net_ports::Picked { port: api_port, bound: listener }) => {", "Some(crate::net_ports::Picked { port: api_port, bound: listener }) if api_net.expose_on_network => {")
            .replacen("                None => {
                    drop(_op);", "                Some(_) => {}
                None => {
                    drop(_op);", 1)),
        ("the bind's result not the match's subject", mutate(LIB, "            match picked {", "            match picked.or(None).filter(|_| false) {")),
        ("the claim's cleanup moved into an uncalled closure's match", mutate(LIB, "                    drop(prepared);
", "                    let _later = || match Some(1) { None => { drop(prepared); } _ => {} };
")),
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

/// `(relative path, occurrences)` of `needle` in each production file's code (comments, literals and
/// test modules masked). A count per file, not a proof of reachability: the sites that must run are
/// pinned by the checks above or proven by the behaviour tests.
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
