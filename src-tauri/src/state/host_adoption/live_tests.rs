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
