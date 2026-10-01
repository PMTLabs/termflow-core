use super::fake_hosts::*;
use super::owner_tests::{machine, create, close, until};
use super::*;
use crate::state::{CloseStorage, EndKind, OwnerState, CreateAdmission, CreateMode};
use crate::state::history::{persist_registered_history, persist_snapshot};
use crate::state::leaf_storage::stripe_index;
use crate::canvas_store::{CanvasStore, CanvasEdge};
use crate::history_store::HistoryStore;
use std::sync::{Condvar, atomic::{AtomicUsize, Ordering}};
use termflow_pty_protocol::{Data, Frame};

// Separate fake worlds still share the process's fixed stripe set. Serializing
// held-gate cases avoids test-created circular waits between unrelated worlds.
static HELD_CASE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
struct Gate { reached: AtomicUsize, released: Mutex<bool>, wake: Condvar }
impl Gate {
    fn hold(&self) {
        self.reached.fetch_add(1, Ordering::SeqCst);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut released = self.released.lock().unwrap();
        while !*released {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            assert!(!remaining.is_zero(), "storage gate deadline");
            released = self.wake.wait_timeout(released, remaining).unwrap().0;
        }
    }
    async fn entered(&self) { until(|| self.reached.load(Ordering::SeqCst) == 1).await; }
    fn release(&self) { *self.released.lock().unwrap() = true; self.wake.notify_all(); }
}
struct Stores { history: HistoryStore, canvas: CanvasStore, path: std::path::PathBuf, effects: Mutex<Vec<String>> }
impl Stores {
    fn new() -> Arc<Self> {
        let path = std::env::temp_dir().join(format!("storage-{}.db", uuid::Uuid::new_v4()));
        let history = HistoryStore::new();
        history.init(&path);
        Arc::new(Self { history, canvas: CanvasStore::new_in_memory(), path, effects: Mutex::new(vec![]) })
    }
    fn attach(self: &Arc<Self>, port: &FakePort) {
        let stores = self.clone();
        *port.0.storage_effect.lock().unwrap() = Some(Arc::new(move |leaf, process, kind| {
            stores.effects.lock().unwrap().push(format!("{process}:{kind:?}"));
            match kind {
                EndKind::Exit => persist_snapshot(&stores.history, leaf, 9, Some(format!("final:{process}").into_bytes())),
                EndKind::Close(CloseStorage::Delete) => {
                    stores.history.delete(leaf);
                    stores.canvas.delete_edges_for(leaf).unwrap();
                }
                _ => {}
            }
        }));
    }
    fn bytes(&self, leaf: &str) -> Option<Vec<String>> { self.history.get(leaf) }
    fn edges(&self) -> String {
        let mut edges = self.canvas.all_edges().unwrap();
        edges.sort_by(|a, b| a.id.cmp(&b.id));
        serde_json::to_string(&edges).unwrap()
    }
}
impl Drop for Stores {
    fn drop(&mut self) {
        // Close the connection before deleting this test's own isolated database.
        self.history = HistoryStore::new();
        let _ = std::fs::remove_file(&self.path);
    }
}
fn session(port: &FakePort, pc: &str) -> String { port.0.terminals.get(pc).unwrap().session_key.clone() }
fn inject_exit(world: &World, port: &FakePort, pc: &str) {
    world.inject_frame("owner-host", 0, Frame::Data(Data::Exit { tab_id: session(port, pc), exit_cwd: None }), None);
}
fn distinct_leaf(leaf: &str) -> String {
    (0..1000).map(|i| format!("tm-control-{i}")).find(|other| stripe_index(other) != stripe_index(leaf)).unwrap()
}
fn no_successor(port: &FakePort, leaf: &str, pc: &str) {
    assert!(matches!(port.table().keys().admit_create(leaf, CreateMode::Mount).unwrap(), CreateAdmission::Existing(current) if current == pc));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn periodic_writer_holds_exit_until_final_persist_and_other_stripe_progresses() {
    let _case = HELD_CASE.lock().await;
    let (world, port) = machine(HostSpec::default());
    let stores = Stores::new();
    stores.attach(&port);
    let leaf = "tm-flush";
    let p = create(&port, leaf).await.unwrap();
    assert_eq!(world.count_everywhere("Spawn"), 1);
    assert_eq!(persist_registered_history(port.table().keys(), &stores.history, leaf, &p, 1, || Some(b"initial:P".to_vec())), Some(()));
    assert_eq!(stores.bytes(leaf), Some(vec!["initial:P".into()]));
    let gate = Arc::new(Gate::default());
    let writer = tokio::task::spawn_blocking({ let port = port.clone(); let stores = stores.clone(); let p = p.clone(); let gate = gate.clone(); move || {
        persist_registered_history(port.table().keys(), &stores.history, leaf, &p, 2, || {
            gate.hold(); Some(b"periodic:P".to_vec())
        })
    }});
    gate.entered().await;
    let other = distinct_leaf(leaf);
    let control = create(&port, &other).await.unwrap();
    assert_eq!(persist_registered_history(port.table().keys(), &stores.history, &other, &control, 3, || Some(b"control".to_vec())), Some(()));
    assert_eq!(stores.bytes(&other), Some(vec!["control".into()]));
    assert_eq!(world.count_everywhere("Spawn"), 2);
    inject_exit(&world, &port, &p);
    until(|| port.0.ending_requested.load(Ordering::SeqCst) == 1).await;
    assert_eq!(gate.reached.load(Ordering::SeqCst), 1);
    assert!(!writer.is_finished());
    assert!(port.0.persisted.lock().unwrap().is_empty());
    assert!(stores.effects.lock().unwrap().is_empty());
    no_successor(&port, leaf, &p);
    gate.release();
    assert_eq!(writer.await.unwrap(), Some(()));
    until(|| port.0.exits.lock().unwrap().len() == 1).await;
    assert_eq!(*port.0.persisted.lock().unwrap(), vec![p.clone()]);
    assert_eq!(*stores.effects.lock().unwrap(), vec![format!("{p}:Exit")]);
    assert_eq!(stores.bytes(leaf), Some(vec![format!("final:{p}")]));
    let q = create(&port, leaf).await.unwrap();
    assert_ne!(q, p);
    assert_eq!(world.count_everywhere("Spawn"), 3);
    assert!(matches!(port.table().keys().owner_state(leaf), Some((_, OwnerState::Registered(s))) if s.process == q));
    assert_eq!(stores.bytes(&other), Some(vec!["control".into()]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removed_shell_writers_skip_history_and_edges_of_registered_replacement() {
    let _case = HELD_CASE.lock().await;
    let (world, port) = machine(HostSpec::default());
    let stores = Stores::new();
    stores.attach(&port);
    let leaf = "tm-delayed";
    let p = create(&port, leaf).await.unwrap();
    let other = distinct_leaf(leaf);
    let parent = create(&port, &other).await.unwrap();
    assert_eq!(persist_registered_history(port.table().keys(), &stores.history, leaf, &p, 1, || Some(b"P".to_vec())), Some(()));
    let gate = Arc::new(Gate::default());
    let ran = Arc::new(AtomicUsize::new(0));
    let delayed = tokio::task::spawn_blocking({ let port = port.clone(); let stores = stores.clone(); let p = p.clone(); let parent = parent.clone(); let other = other.clone(); let gate = gate.clone(); let ran = ran.clone(); move || {
        gate.hold();
        let history = persist_registered_history(port.table().keys(), &stores.history, leaf, &p, 7, || {
            ran.fetch_add(1, Ordering::SeqCst); Some(b"stale:P".to_vec())
        });
        let edge = port.table().keys().write_shells(&[(leaf, &p), (&other, &parent)], || {
            ran.fetch_add(1, Ordering::SeqCst);
            stores.canvas.insert_edge(&CanvasEdge::new(leaf.into(), other.clone(), None, "agent")).unwrap();
        });
        (history, edge)
    }});
    gate.entered().await;
    inject_exit(&world, &port, &p);
    until(|| port.0.exits.lock().unwrap().len() == 1).await;
    assert_eq!(*port.0.persisted.lock().unwrap(), vec![p.clone()]);
    let q = create(&port, leaf).await.unwrap();
    assert_ne!(q, p);
    assert_eq!(world.count_everywhere("Spawn"), 3);
    assert_eq!(persist_registered_history(port.table().keys(), &stores.history, leaf, &q, 10, || Some(b"Q:history".to_vec())), Some(()));
    let q_edge = CanvasEdge::new(other.clone(), leaf.into(), Some("Q:canvas".into()), "user");
    assert!(port.table().keys().write_shells(&[(leaf, &q), (&other, &parent)], || stores.canvas.insert_edge(&q_edge).unwrap()).is_some());
    assert_eq!(stores.canvas.all_edges().unwrap().len(), 1);
    let before = (stores.bytes(leaf), stores.edges());
    gate.release();
    assert_eq!(delayed.await.unwrap(), (None, None));
    assert_eq!(ran.load(Ordering::SeqCst), 0);
    assert_eq!((stores.bytes(leaf), stores.edges()), before);
    assert_eq!(persist_registered_history(port.table().keys(), &stores.history, leaf, &q, 11, || Some(b"Q:next".to_vec())), Some(()));
    assert_eq!(stores.bytes(leaf), Some(vec!["Q:next".into()]));
    assert_eq!(stores.canvas.get_by_id(&q_edge.id).unwrap().unwrap().label.as_deref(), Some("Q:canvas"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn checked_auto_connect_edge_finishes_before_exit_and_never_writes_after_replacement() {
    let _case = HELD_CASE.lock().await;
    let (world, port) = machine(HostSpec::default());
    let stores = Stores::new();
    stores.attach(&port);
    let leaf = "tm-auto-edge";
    let p = create(&port, leaf).await.unwrap();
    let other = distinct_leaf(leaf);
    let parent = create(&port, &other).await.unwrap();
    let control_leaf = (0..1000).map(|i| format!("tm-edge-control-{i}")).find(|id|
        stripe_index(id) != stripe_index(leaf) && stripe_index(id) != stripe_index(&other)).unwrap();
    let control = create(&port, &control_leaf).await.unwrap();
    let gate = Arc::new(Gate::default());
    let p_edge = CanvasEdge::new(other.clone(), leaf.into(), Some("P:edge".into()), "agent");
    let writer = tokio::task::spawn_blocking({ let port = port.clone(); let stores = stores.clone(); let p = p.clone(); let parent = parent.clone(); let other = other.clone(); let gate = gate.clone(); let edge = p_edge.clone(); move || {
        port.table().keys().write_shells(&[(leaf, &p), (&other, &parent)], || {
            gate.hold(); stores.canvas.insert_edge(&edge).unwrap()
        }).is_some()
    }});
    gate.entered().await;
    inject_exit(&world, &port, &p);
    until(|| port.0.ending_requested.load(Ordering::SeqCst) == 1).await;
    assert_eq!(gate.reached.load(Ordering::SeqCst), 1);
    assert!(stores.canvas.all_edges().unwrap().is_empty());
    assert!(port.0.exits.lock().unwrap().is_empty());
    no_successor(&port, leaf, &p);
    // A single-leaf writer on a third stripe remains independent of the edge.
    assert_eq!(persist_registered_history(port.table().keys(), &stores.history, &control_leaf, &control, 2, || Some(b"control".to_vec())), Some(()));
    gate.release();
    assert!(writer.await.unwrap());
    until(|| port.0.exits.lock().unwrap().len() == 1).await;
    assert_eq!(stores.canvas.all_edges().unwrap().len(), 1);
    assert_eq!(stores.canvas.get_by_id(&p_edge.id).unwrap().unwrap().label.as_deref(), Some("P:edge"));
    let q = create(&port, leaf).await.unwrap();
    assert_ne!(q, p);
    let before = stores.edges();
    let ran = AtomicUsize::new(0);
    assert!(port.table().keys().write_shells(&[(leaf, &p), (&other, &parent)], || {
        ran.fetch_add(1, Ordering::SeqCst);
        stores.canvas.insert_edge(&CanvasEdge::new(leaf.into(), other.clone(), None, "agent")).unwrap();
    }).is_none());
    assert_eq!(ran.load(Ordering::SeqCst), 0);
    assert_eq!(stores.edges(), before);
    assert!(port.table().keys().write_shells(&[(leaf, &q), (&other, &parent)], || {
        stores.canvas.insert_edge(&CanvasEdge::new(leaf.into(), other.clone(), Some("Q:edge".into()), "agent")).unwrap()
    }).is_some());
    assert_eq!(stores.canvas.all_edges().unwrap().len(), 2);
    assert_eq!(*port.0.persisted.lock().unwrap(), vec![p]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_deletes_after_checked_writer_and_stale_writer_cannot_resurrect_storage() {
    let _case = HELD_CASE.lock().await;
    let (world, port) = machine(HostSpec::default());
    let stores = Stores::new();
    stores.attach(&port);
    let leaf = "tm-close-storage";
    let p = create(&port, leaf).await.unwrap();
    let p_key = session(&port, &p);
    let gate = Arc::new(Gate::default());
    let writer = tokio::task::spawn_blocking({ let port = port.clone(); let stores = stores.clone(); let p = p.clone(); let gate = gate.clone(); move || {
        persist_registered_history(port.table().keys(), &stores.history, leaf, &p, 1, || {
            gate.hold();
            stores.canvas.insert_edge(&CanvasEdge::new(leaf.into(), "tm-other".into(), None, "agent")).unwrap();
            Some(b"P:last-write".to_vec())
        })
    }});
    gate.entered().await;
    let ending = tokio::task::spawn_blocking({ let port = port.clone(); let p = p.clone(); move || close(&port, &p, CloseStorage::Delete) });
    until(|| port.0.ending_requested.load(Ordering::SeqCst) == 1).await;
    assert!(matches!(port.table().keys().owner_state(leaf), Some((_, OwnerState::Closing(s))) if s.process == p));
    assert!(port.table().keys().admit_create(leaf, CreateMode::Mount).is_err());
    assert!(!ending.is_finished());
    assert!(stores.effects.lock().unwrap().is_empty());
    assert_eq!(world.count_everywhere("Close"), 0);
    gate.release();
    assert_eq!(writer.await.unwrap(), Some(()));
    assert!(ending.await.unwrap());
    port.current_client().unwrap().list_sessions_numbered().await.unwrap();
    assert_eq!(world.sessions("owner-host", "Close"), vec![p_key]);
    assert_eq!(*port.0.deleted.lock().unwrap(), vec![leaf.to_string()]);
    assert_eq!(*stores.effects.lock().unwrap(), vec![format!("{p}:Close(Delete)")]);
    assert_eq!(stores.bytes(leaf), None);
    assert!(stores.canvas.all_edges().unwrap().is_empty());
    let q = create(&port, leaf).await.unwrap();
    assert_ne!(q, p);
    assert_eq!(world.count_everywhere("Spawn"), 2);
    let ran = AtomicUsize::new(0);
    assert_eq!(persist_registered_history(port.table().keys(), &stores.history, leaf, &p, 8, || {
        ran.fetch_add(1, Ordering::SeqCst); Some(b"stale:P".to_vec())
    }), None);
    assert_eq!(ran.load(Ordering::SeqCst), 0);
    assert_eq!(stores.bytes(leaf), None);
    assert!(stores.canvas.all_edges().unwrap().is_empty());
    assert_eq!(persist_registered_history(port.table().keys(), &stores.history, leaf, &q, 9, || Some(b"Q".to_vec())), Some(()));
    assert_eq!(stores.bytes(leaf), Some(vec!["Q".into()]));
}
