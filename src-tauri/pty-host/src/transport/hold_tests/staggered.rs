//! 054's deferred degradation: a clock failure on B must never extend holder A.
use super::*;

#[tokio::test]
async fn staggered_deadlines_are_per_host_not_extended_by_companions() {
    let a_clock = Clock::new(0);
    let b_clock = Clock::new(0);
    let mut a = Host::start("stagger-a", &a_clock);
    let mut b = Host::start("stagger-b", &b_clock);
    let port = free_port("127.0.0.1");
    let mut a_gui = a.gui().await;
    let mut b_gui = b.gui().await;
    let a_pid = a_gui.spawn("a-original").await;
    let b_pid = b_gui.spawn("b-original").await;
    a_gui.arm_local().await;
    b_gui.arm_local().await;
    a_gui.hold_accepted(spec(port, "127.0.0.1")).await;
    b_clock.fail(); // Failure at B's disconnect, not shared with A.
    drop(a_gui);
    drop(b_gui);
    assert!(wait_answers(port, Duration::from_secs(10)).await);
    pump(Duration::from_millis(600)).await;
    b_clock.set(120);
    pump(Duration::from_millis(1100)).await; // B establishes its own deadline at 120+900.
    a_clock.set(899);
    b_clock.set(899);
    pump(Duration::from_millis(600)).await;
    assert!(!a.finished() && !b.finished());
    assert!(pid_is_alive(a_pid) && pid_is_alive(b_pid));
    assert!(call(port).await.is_some());
    a_clock.set(900);
    b_clock.set(900);
    assert!(
        a.wait_finished(Duration::from_secs(90)).await,
        "A ends at its own 900s deadline"
    );
    (&mut a.srv).await.unwrap().unwrap(); // await actual cleanup, not an aggregate gauge
    assert!(refuses(port), "A's holder is gone; B cannot extend it");
    assert!(!pid_is_alive(a_pid));
    assert!(
        !b.finished() && pid_is_alive(b_pid),
        "B's ORIGINAL shell survives A's deadline"
    );
    b_clock.set(1019);
    pump(Duration::from_millis(600)).await;
    assert!(!b.finished() && pid_is_alive(b_pid));
    b_clock.set(1020);
    assert!(
        b.wait_finished(Duration::from_secs(90)).await,
        "B ends at its later deadline"
    );
    (&mut b.srv).await.unwrap().unwrap();
    assert!(!pid_is_alive(b_pid));
    eprintln!("MEASURE staggered: A deadline=900s, B deadline=1020s; accepted uncovered interval=120 active seconds");
}
