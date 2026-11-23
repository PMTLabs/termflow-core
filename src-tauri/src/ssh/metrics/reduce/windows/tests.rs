use super::*;
use crate::ssh::metrics::{protocol::parse, reduce::Reducer, sampler::CADENCE};

const NONCE: &str = "0123456789abcdef0123456789abcdef";
const CAPTURE: &str = include_str!("../../fixtures/windows.txt");

fn capture(reducer: &mut Reducer, text: &str) -> Metrics {
    reducer.reduce(parse(text.as_bytes(), NONCE).unwrap())
}

fn section_data(text: &str, key: &str, body: &str) -> String {
    let start = format!("__TFM_{NONCE}_SECTION_{key}_BEGIN__\n");
    let marker = format!("__TFM_{NONCE}_SECTION_{key}_END_");
    let (head, rest) = text.split_once(&start).unwrap();
    let (_, end) = rest.split_once(&marker).unwrap();
    format!("{head}{start}{body}\n{marker}{end}")
}

fn frame(
    reducer: &mut Reducer,
    clock_index: u64,
    counter_index: u64,
    adapter: &str,
    rx: u64,
) -> Metrics {
    let hz = 10_000_000;
    let ticks = (100 + clock_index * 2 * CADENCE.as_secs()) * hz;
    let text = section_data(
        CAPTURE,
        "winOs",
        &format!("uptimeTicks {ticks}\ntickFrequency {hz}"),
    );
    let d = counter_index * CADENCE.as_secs();
    let text = section_data(
        &text,
        "winCpu",
        &format!(
            "idle100ns {}\nkernel100ns {}\nuser100ns {}\ncores 24",
            100 + d,
            400 + 3 * d,
            900 + d
        ),
    );
    let text = section_data(&text, "winNet", &format!("{rx} {} {adapter}", 200 + 6 * d));
    capture(reducer, &text)
}

fn cpu_percent_of(metrics: &Metrics) -> Option<f64> {
    let Metric::Available(cpu) = &metrics.cpu else {
        panic!("{:?}", metrics.cpu)
    };
    cpu.percent
}

fn rate(metric: &Metric<Network>) -> Option<f64> {
    let Metric::Available(network) = metric else {
        panic!("{metric:?}")
    };
    network.bytes_per_second
}

#[test]
fn windows_cpu_needs_a_baseline_then_matches_formula() {
    let mut reducer = Reducer::default();
    assert_eq!(cpu_percent_of(&frame(&mut reducer, 0, 0, "A", 0)), None);
    assert_eq!(
        cpu_percent_of(&frame(&mut reducer, 1, 1, "A", 1)),
        Some(75.0)
    );
    assert_eq!(cpu_percent_of(&frame(&mut reducer, 2, 0, "A", 2)), None);
    assert_eq!(
        cpu_percent_of(&frame(&mut reducer, 3, 1, "A", 3)),
        Some(75.0)
    );
}

#[test]
fn windows_network_rate_uses_qpc_delta_not_nominal_cadence() {
    let mut reducer = Reducer::default();
    assert_eq!(rate(&frame(&mut reducer, 0, 0, "A", 100).net_down), None);
    let next = frame(&mut reducer, 1, 1, "A", 100 + 4 * CADENCE.as_secs());
    assert_eq!(
        (rate(&next.net_down), rate(&next.net_up)),
        (Some(2.0), Some(3.0))
    );
}

#[test]
fn windows_instance_set_change_resets_baseline() {
    let mut reducer = Reducer::default();
    frame(&mut reducer, 0, 0, "A", 100);
    assert_eq!(rate(&frame(&mut reducer, 1, 1, "B", 110).net_down), None);
    assert_eq!(rate(&frame(&mut reducer, 2, 2, "B", 10).net_down), None);
    assert_eq!(
        rate(&frame(&mut reducer, 3, 3, "B", 10 + 4 * CADENCE.as_secs()).net_down),
        Some(2.0)
    );
}

#[test]
fn windows_backwards_uptime_resets_both_baselines_even_with_increasing_counters() {
    let mut reducer = Reducer::default();
    frame(&mut reducer, 0, 0, "A", 0);
    let same_boot = frame(&mut reducer, 1, 1, "A", 1);
    assert_eq!(cpu_percent_of(&same_boot), Some(75.0));
    assert!(rate(&same_boot.net_down).is_some());
    let other_boot = frame(&mut reducer, 0, 2, "A", 2);
    assert_eq!(cpu_percent_of(&other_boot), None);
    assert_eq!(rate(&other_boot.net_down), None);
    assert_eq!(
        cpu_percent_of(&frame(&mut reducer, 1, 3, "A", 3)),
        Some(75.0)
    );
}

#[test]
fn windows_load1_is_unavailable_with_reason() {
    let metrics = capture(&mut Reducer::default(), CAPTURE);
    assert_eq!(metrics.platform, Some("Windows"));
    assert_eq!(metrics.unsupported_platform, None);
    let Metric::Available(cpu) = metrics.cpu else {
        panic!("CPU should be available")
    };
    assert_eq!(cpu.load1, Metric::Unavailable(NO_LOAD.into()));
    assert_eq!(cpu.cores, Metric::Available(Cores { count: 24 }));
}

#[test]
fn windows_ram_formula_and_qpc_uptime() {
    let metrics = capture(&mut Reducer::default(), CAPTURE);
    let (total, free) = (136_770_584_576_u64, 43_341_094_912_u64);
    assert_eq!(
        metrics.ram,
        Metric::Available(Ram {
            total_bytes: total,
            used_bytes: total - free,
            percent: 100.0 * (total - free) as f64 / total as f64,
        })
    );
    assert_eq!(
        metrics.uptime,
        Metric::Available(Uptime {
            seconds: 10_714_475_851_337.0 / 10_000_000.0
        })
    );
}

#[test]
fn windows_user_failure_explains_admin_requirement() {
    let denied = include_str!("../../fixtures/windows-users-denied.txt");
    let failed = denied.replace("winUsers_END_126", "winUsers_END_1");
    for text in [denied, &failed] {
        let metrics = capture(&mut Reducer::default(), text);
        assert_eq!(
            metrics.users,
            Metric::Unavailable(
                "Signed-in users require an administrator account on Windows".into()
            )
        );
    }
}

#[test]
fn windows_ram_block_does_not_hide_working_clock_or_cpu() {
    let frame = CAPTURE
        .replace(
            "totalBytes 136770584576\navailBytes 43341094912",
            "blocked 1",
        )
        .replace("winOs_END_0", "winOs_END_126");
    let metrics = capture(&mut Reducer::default(), &frame);
    assert_eq!(metrics.ram, Metric::Unavailable(BLOCKED.into()));
    assert!(matches!(metrics.uptime, Metric::Available(_)));
    assert!(matches!(metrics.cpu, Metric::Available(_)));
    assert!(matches!(metrics.host, Metric::Available(_)));
}
