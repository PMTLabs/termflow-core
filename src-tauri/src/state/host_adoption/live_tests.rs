//! Live operations on a terminal (keystrokes, resizes, repaints, closes) reach
//! the host that owns it and no other. Every assertion names the host that
//! received a frame: "a frame was sent" is true of the wrong host too.

use super::fake_hosts::*;
use super::*;
use crate::state::host_registry;

const CURRENT: &str = "cur";
const SEC: Duration = Duration::from_secs(1);

fn holding(keys: &[(&str, u32)]) -> HostSpec {
    HostSpec { sessions: keys.iter().map(|(k, pid)| meta(k, *pid)).collect(), ..HostSpec::default() }
}

/// The current host plus these older hosts, all adopted.
async fn adopted(old: &[(&str, HostSpec)]) -> (Arc<World>, FakePort) {
    let world = World::new();
    world.add_host(CURRENT, HostSpec::default());
    let mut candidates = Vec::new();
    for (name, spec) in old {
        world.add_host(name, spec.clone());
        candidates.push(candidate(name, HostRole::Frozen));
    }
    candidates.push(candidate(CURRENT, HostRole::Current));
    let port = FakePort::new(&world, CURRENT);
    port.set_candidates(candidates);
    ensure_hosts(&port).await.unwrap();
    tokio::time::sleep(SEC).await;
    (world, port)
}

fn channel_of(port: &FakePort, endpoint: &str) -> HostChannel {
    HostChannel::Frozen(port.frozen_hosts().iter().find(|h| h.endpoint == endpoint).expect("registered").id)
}

fn frozen_id(channel: HostChannel) -> FrozenId {
    match channel {
        HostChannel::Frozen(id) => id,
        other => panic!("{other:?} is not an older host"),
    }
}

#[tokio::test(start_paused = true)]
async fn frozen_channel_routes_to_its_clients_frame() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11)])), ("h2", holding(&[("k2", 22)]))]).await;
    let (h1, h2) = (channel_of(&port, "h1"), channel_of(&port, "h2"));
    port.register_terminal("pc-p", "tm-p", HostChannel::Primary);
    port.register_terminal("pc-1", "k1", h1);
    port.register_terminal("pc-2", "k2", h2);
    let t = &port.0;
    let client_for = |channel| port.client_for(channel);

    // The host knows a terminal by its session key, not by our process id.
    assert!(host_registry::route_write(&t.host_terminals, &t.terminals, "pc-1", b"ls\r", &client_for));
    assert!(host_registry::route_resize(&t.host_terminals, &t.terminals, "pc-2", 100, 30, &client_for));
    assert!(host_registry::route_repaint(&t.host_terminals, &t.terminals, "pc-p", &client_for));
    tokio::time::sleep(SEC).await;

    assert_eq!(world.sessions("h1", "Stdin"), vec!["k1".to_string()], "the keystrokes reached the owning older host");
    assert_eq!(world.sessions("h2", "Resize"), vec!["k2".to_string()], "the resize reached the other older host");
    assert_eq!(
        world.sessions(CURRENT, "Resize"),
        vec!["tm-p".to_string(), "tm-p".to_string()],
        "a repaint nudge is a resize and a resize back, on the owning host"
    );
    // And nothing crossed over to another host.
    assert_eq!(world.count("h1", "Stdin"), 1);
    assert_eq!(world.count("h2", "Stdin"), 0);
    assert_eq!(world.count(CURRENT, "Stdin"), 0);
    assert_eq!(world.count("h1", "Resize"), 0);
    assert_eq!(world.count("h2", "Resize"), 1);
}

#[tokio::test(start_paused = true)]
async fn a_frozen_terminal_without_a_live_client_behaves_like_a_disconnected_primary() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11)]))]).await;
    let h1 = channel_of(&port, "h1");
    port.register_terminal("pc-p", "tm-p", HostChannel::Primary);
    port.register_terminal("pc-1", "k1", h1);
    let t = &port.0;
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    assert!(!port.frozen_hosts()[0].client.is_alive(), "the host's connection really dropped");
    let client_for = |channel| port.client_for(channel);

    // The registry still holds the host while it is reconnected, but there is no
    // client to act on: the failure is reported, never diverted to another host
    // and never reported as delivered.
    assert!(!host_registry::route_write(&t.host_terminals, &t.terminals, "pc-1", b"ls\r", &client_for));
    assert!(!host_registry::route_resize(&t.host_terminals, &t.terminals, "pc-1", 100, 30, &client_for));
    assert!(host_registry::route_repaint(&t.host_terminals, &t.terminals, "pc-1", &client_for), "still host-owned");
    // A terminal no host owns is not routed at all.
    assert!(!host_registry::route_write(&t.host_terminals, &t.terminals, "pc-nobody", b"x", &client_for));
    tokio::time::sleep(SEC).await;
    for kind in ["Stdin", "Resize"] {
        assert_eq!(world.count_everywhere(kind), 0, "no {kind} frame went to any host");
    }
}

#[tokio::test(start_paused = true)]
async fn close_while_frozen_disconnected_is_deferred_and_delivered_on_that_hosts_reconnect() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11), ("k2", 12)])), ("h2", holding(&[("k3", 13)]))]).await;
    let (h1, h2) = (channel_of(&port, "h1"), channel_of(&port, "h2"));
    port.register_terminal("pc-1", "k1", h1);
    port.register_terminal("pc-2", "k2", h1);
    port.register_terminal("pc-3", "k3", h2);
    let t = &port.0;
    let lost_epoch = t.table.epoch(h1).expect("published");
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;

    // The user closes the pane while the host's pipe is down, the way `host_close`
    // does: the close is owed, and the pane is forgotten.
    host_registry::route_close(&t.host_close_pending, h1, "k1", port.client_for(h1));
    t.host_terminals.remove("pc-1");
    t.terminals.remove("pc-1");
    assert_eq!(world.count_everywhere("Close"), 0, "nothing could be delivered yet");
    assert_eq!(t.host_close_pending.get("k1").map(|c| *c.value()), Some(h1), "owed to the host that owns it");

    // A close for a healthy host goes straight to it and is not owed.
    host_registry::route_close(&t.host_close_pending, h2, "k3", port.client_for(h2));
    tokio::time::sleep(SEC).await;
    assert_eq!(world.sessions("h2", "Close"), vec!["k3".to_string()]);
    assert!(!t.host_close_pending.contains_key("k3"));

    // The host comes back: it is told, and only it.
    let outcome = reconnect_frozen(&port, frozen_id(h1), lost_epoch, &[500]).await;
    assert_eq!(outcome, super::reconnect::FrozenReconnect::Reconnected);
    tokio::time::sleep(SEC).await;
    assert_eq!(world.sessions("h1", "Close"), vec!["k1".to_string()], "delivered on that host's reconnect");
    assert_eq!(world.count(CURRENT, "Close"), 0);
    assert_eq!(world.sessions("h2", "Close"), vec!["k3".to_string()], "and not delivered to any other host again");
    assert!(t.host_close_pending.is_empty(), "the tombstone is spent");
    // The session that was closed is not brought back as a recovered terminal, and
    // the pane that is still open is reattached in place.
    assert!(port.0.recovered.lock().unwrap().is_empty());
    assert_eq!(world.sessions("h1", "Attach"), vec!["k2".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn a_tombstone_owed_to_one_host_survives_another_hosts_listing() {
    let (world, port) = adopted(&[("h1", holding(&[("k1", 11)])), ("h2", HostSpec::default())]).await;
    let (h1, h2) = (channel_of(&port, "h1"), channel_of(&port, "h2"));
    let t = &port.0;
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;
    host_registry::route_close(&t.host_close_pending, h1, "k1", port.client_for(h1));

    // h2 answers a listing (empty): that is h2's business alone.
    let h2_client = port.client_for(h2).expect("connected");
    port.apply_listing(h2, &h2_client, Some(Vec::<SessionMeta>::new().as_slice()));
    assert_eq!(t.host_close_pending.get("k1").map(|c| *c.value()), Some(h1), "h2's answer cannot settle h1's close");
    assert_eq!(world.count_everywhere("Close"), 0);
}

/// A real host reaps a session after it has heard the close, not before it. A
/// listing taken in between still has the session, and what it is shown must not
/// be handed back to the user as a recovered terminal.
#[tokio::test(start_paused = true)]
async fn a_listing_taken_just_after_a_deferred_close_does_not_bring_the_pane_back() {
    let lagging = HostSpec { close_lag: Duration::from_secs(5), ..holding(&[("k1", 11), ("k2", 12)]) };
    let (world, port) = adopted(&[("h1", lagging)]).await;
    let h1 = channel_of(&port, "h1");
    port.register_terminal("pc-1", "k1", h1);
    port.register_terminal("pc-2", "k2", h1);
    let t = &port.0;
    let lost_epoch = t.table.epoch(h1).expect("published");
    world.kill_connections("h1");
    tokio::time::sleep(SEC).await;

    // The user closes k1's pane while the host's pipe is down.
    host_registry::route_close(&t.host_close_pending, h1, "k1", port.client_for(h1));
    t.host_terminals.remove("pc-1");
    t.terminals.remove("pc-1");

    // The reconnect delivers the close, then lists the host again at once.
    let outcome = reconnect_frozen(&port, frozen_id(h1), lost_epoch, &[500]).await;
    assert_eq!(outcome, super::reconnect::FrozenReconnect::Reconnected);
    tokio::time::sleep(SEC).await;

    assert!(port.0.recovered.lock().unwrap().is_empty(), "the pane the user closed was not offered back");
    assert_eq!(
        world.sessions("h1", "Close"),
        vec!["k1".to_string(), "k1".to_string()],
        "the close was delivered, and repeated when the host still listed the session"
    );
    assert_eq!(world.sessions("h1", "Attach"), vec!["k2".to_string()], "the pane that is still open was reattached");

    // Once the host has reaped it, nothing mentions k1 any more.
    tokio::time::sleep(Duration::from_secs(10)).await;
    let client = port.client_for(h1).expect("connected");
    let listed: Vec<String> = client.list_sessions().await.expect("answered").into_iter().map(|s| s.tab_id).collect();
    assert_eq!(listed, vec!["k2".to_string()]);
}

fn production_of(file: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("state").join(file);
    crate::state::source_scan::production(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {} ({e})", path.display())))
}

/// `AppState` cannot be built in a unit test, so its live operations are read from
/// source: each must hand the router the channel of the terminal it was asked
/// about, not a client chosen up front. A write to an older host's pane that went to
/// the primary instead would pass every test above, which call the router directly.
#[test]
fn appstates_live_operations_route_each_terminal_to_its_own_hosts_client() {
    use crate::state::source_scan::fn_body;
    let terminals = production_of("terminals.rs");

    for (signature, route) in [
        ("pub fn host_write(", "route_write("),
        ("pub fn host_resize(", "route_resize("),
        ("pub fn host_repaint(", "route_repaint("),
    ] {
        let body = fn_body(&terminals, signature);
        let call = &body[body.find(route).unwrap_or_else(|| panic!("{signature} no longer routes: {body}"))..];
        // The closure the router asks for a channel's client with: `&|c| self.client_for_channel(c)`.
        let closure = &call[call.find("&|").unwrap_or_else(|| panic!("no closure passed on: {call}")) + 2..];
        let param = &closure[..closure.find('|').expect("a closure parameter")];
        assert!(
            closure[param.len() + 1..].trim_start().starts_with(&format!("self.client_for_channel({})", param.trim())),
            "{signature} must resolve the channel it is given, not pick a client itself: {call}"
        );
        assert!(!body.contains("HostChannel::Primary") && !body.contains("pty_host_clone"), "{signature}: {body}");
    }

    // A close is owed to the channel that owns the pane, and the client it goes
    // through is that channel's.
    let close = fn_body(&terminals, "pub fn host_close(");
    assert!(close.contains("self.host_channel_for(id)"), "{close}");
    let route_close = &close[close.find("route_close(").expect("host_close routes the close")..];
    assert!(route_close.contains("channel, &session_key, self.client_for_channel(channel))"), "{route_close}");

    // And the channel's client is the registered host's for an older host.
    let client_for_channel = fn_body(&terminals, "fn client_for_channel(");
    assert!(client_for_channel.contains("HostChannel::Frozen(id) => self.frozen_client(id)"), "{client_for_channel}");
    assert_eq!(client_for_channel.matches("pty_host_clone()").count(), 1, "the primary's client is for the primary only");
    assert!(fn_body(&terminals, "fn host_channel_for(").contains("self.host_terminals.get(id)"));
}
