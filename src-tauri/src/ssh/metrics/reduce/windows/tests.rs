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
    frame_at(reducer, clock_index, counter_index, adapter, rx, 10_000_000, false)
}

fn frame_at(
    reducer: &mut Reducer,
    clock_index: u64,
    counter_index: u64,
    adapter: &str,
    rx: u64,
    hz: u64,
    watchdog: bool,
) -> Metrics {
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
            // Distinct idle and user deltas, so swapping the two fields changes the result.
            900 + 2 * d
        ),
    );
    let text = section_data(&text, "winNet", &format!("{rx} {} {adapter}", 200 + 6 * d));
    let text = if watchdog {
        text.replace("winNetDrives_END_0__", "winNetDrives_END_137__")
    } else {
        text
    };
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
        Some(80.0)
    );
    assert_eq!(cpu_percent_of(&frame(&mut reducer, 2, 0, "A", 2)), None);
    assert_eq!(
        cpu_percent_of(&frame(&mut reducer, 3, 1, "A", 3)),
        Some(80.0)
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

fn adapter_frame(reducer: &mut Reducer, index: u64, rows: &str) -> Metrics {
    let hz = 10_000_000;
    let ticks = (100 + index * 2 * CADENCE.as_secs()) * hz;
    let text = section_data(CAPTURE, "winOs", &format!("uptimeTicks {ticks}\ntickFrequency {hz}"));
    capture(reducer, &section_data(&text, "winNet", rows))
}

#[test]
fn windows_rates_over_common_adapters() {
    let mut reducer = Reducer::default();
    let step = 2 * CADENCE.as_secs();
    adapter_frame(&mut reducer, 0, "100 200 A");
    let added = adapter_frame(&mut reducer, 1, &format!("{} {} A\n9999 9999 B", 100 + step, 200 + 2 * step));
    assert_eq!((rate(&added.net_down), rate(&added.net_up)), (Some(1.0), Some(2.0)));
    let removed = adapter_frame(&mut reducer, 2, &format!("{} {} A", 100 + 4 * step, 200 + 6 * step));
    assert_eq!((rate(&removed.net_down), rate(&removed.net_up)), (Some(3.0), Some(4.0)));
    let decreased = adapter_frame(&mut reducer, 3, "10 20 A");
    assert_eq!((rate(&decreased.net_down), rate(&decreased.net_up)), (None, None));
    let replaced = adapter_frame(&mut reducer, 4, "9999 9999 B");
    assert_eq!((rate(&replaced.net_down), rate(&replaced.net_up)), (None, None));
}

#[test]
fn windows_two_common_adapters_with_one_added_between_them() {
    let mut reducer = Reducer::default();
    let step = 2 * CADENCE.as_secs();
    adapter_frame(&mut reducer, 0, "100 200 A\n300 400 C");
    // B sorts between the survivors; every common adapter counts, not just the first.
    let now = adapter_frame(&mut reducer, 1, &format!(
        "{} {} A\n99999 99999 B\n{} {} C", 100 + step, 200 + 2 * step, 300 + 3 * step, 400 + 4 * step
    ));
    assert_eq!((rate(&now.net_down), rate(&now.net_up)), (Some(4.0), Some(6.0)));
}

#[test]
fn windows_backwards_uptime_resets_both_baselines_even_with_increasing_counters() {
    let mut reducer = Reducer::default();
    frame(&mut reducer, 0, 0, "A", 0);
    let same_boot = frame(&mut reducer, 1, 1, "A", 1);
    assert_eq!(cpu_percent_of(&same_boot), Some(80.0));
    assert!(rate(&same_boot.net_down).is_some());
    let other_boot = frame(&mut reducer, 0, 2, "A", 2);
    assert_eq!(cpu_percent_of(&other_boot), None);
    assert_eq!(rate(&other_boot.net_down), None);
    assert_eq!(
        cpu_percent_of(&frame(&mut reducer, 1, 3, "A", 3)),
        Some(80.0)
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
    assert!(matches!(metrics.host, Metric::Available(Host {
        os: Metric::Available(_),
        architecture: Metric::Available(_),
        ..
    })));
}

#[test]
fn sshd_non_admin_capture_reduces_every_metric_but_users() {
    let text = include_str!("../../fixtures/windows-sshd-nonadmin.txt");
    let metrics = capture(&mut Reducer::default(), text);
    assert_eq!(metrics.platform, Some("Windows"));
    let total = 136_770_584_576u64;
    let used = total - 53_008_818_176;
    assert!(matches!(
        &metrics.ram,
        Metric::Available(Ram { used_bytes, total_bytes, .. })
            if *used_bytes == used && *total_bytes == total
    ));
    assert_eq!(
        metrics.uptime,
        Metric::Available(Uptime {
            seconds: 10_727_166_953_538.0 / 10_000_000.0
        })
    );
    assert!(matches!(
        &metrics.cpu,
        Metric::Available(Cpu {
            percent: None,
            cores: Metric::Available(Cores { count: 24 }),
            ..
        })
    ));
    assert!(matches!(&metrics.partitions, Metric::Available(p) if p.mounts.len() == 4));
    assert!(matches!(&metrics.nfs, Metric::Available(p) if p.mounts.is_empty()));
    assert!(matches!(&metrics.net_up, Metric::Available(_)));
    assert!(matches!(&metrics.host, Metric::Available(_)));
    assert_eq!(
        metrics.users,
        Metric::Unavailable("Signed-in users require an administrator account on Windows".into())
    );
}

#[test]
fn windows_sample_that_measured_nothing_is_flagged_unavailable() {
    let keys = [
        "hostname",
        "architecture",
        "winOs",
        "winCpu",
        "winNet",
        "winUsers",
        "winDisks",
        "winNetDrives",
    ];
    let mut text = format!(
        "__TFM_{NONCE}_V1_BEGIN__\n__TFM_{NONCE}_SECTION_platform_BEGIN__\nWindows\n__TFM_{NONCE}_SECTION_platform_END_0__\n"
    );
    for key in keys {
        text +=
            &format!("__TFM_{NONCE}_SECTION_{key}_BEGIN__\n__TFM_{NONCE}_SECTION_{key}_END_1__\n");
    }
    text += &format!("__TFM_{NONCE}_V1_END__\n");
    let metrics = capture(&mut Reducer::default(), &text);
    assert_eq!(metrics.platform, Some("Windows"));
    let Metric::Unavailable(cpu) = &metrics.cpu else {
        panic!("cpu measured from failed sections");
    };
    assert_eq!(metrics.unavailable_reason.as_deref(), Some(cpu.as_str()));

    // The non-admin sshd capture measures everything but users: no flag.
    let sshd = include_str!("../../fixtures/windows-sshd-nonadmin.txt");
    assert_eq!(
        capture(&mut Reducer::default(), sshd).unavailable_reason,
        None
    );
}

#[test]
fn windows_watchdog_after_a_baseline_drops_rates_and_rewarms() {
    let mut reducer = Reducer::default();
    frame(&mut reducer, 0, 0, "A", 0);
    assert_eq!(cpu_percent_of(&frame(&mut reducer, 1, 1, "A", 1)), Some(80.0));
    let hung = frame_at(&mut reducer, 2, 2, "A", 2, 10_000_000, true);
    assert_eq!(cpu_percent_of(&hung), None);
    assert_eq!(rate(&hung.net_down), None);
    assert_eq!(rate(&hung.net_up), None);
    // The watchdog sample seeds nothing: the next one is a fresh baseline.
    let after = frame(&mut reducer, 3, 3, "A", 3);
    assert_eq!(cpu_percent_of(&after), None);
    assert_eq!(rate(&after.net_down), None);
    assert_eq!(cpu_percent_of(&frame(&mut reducer, 4, 4, "A", 4)), Some(80.0));
}

#[test]
fn windows_qpc_frequency_change_resets_both_baselines() {
    let mut reducer = Reducer::default();
    frame(&mut reducer, 0, 0, "A", 0);
    // A higher frequency keeps uptimeTicks increasing (1.0e9 -> 3.6e9), so the
    // backwards-uptime guard cannot mask a missing frequency check.
    let changed = frame_at(&mut reducer, 1, 1, "A", 1, 30_000_000, false);
    assert_eq!(cpu_percent_of(&changed), None);
    assert_eq!(rate(&changed.net_down), None);
    let same = frame_at(&mut reducer, 2, 2, "A", 2, 30_000_000, false);
    assert_eq!(cpu_percent_of(&same), Some(80.0));
    assert!(rate(&same.net_down).is_some());
}

#[test]
fn windows_blocked_os_and_users_name_the_block_not_a_parse_or_admin_error() {
    let text = CAPTURE
        .replace(
            &CAPTURE[CAPTURE.find("caption ").unwrap()..CAPTURE.find("
__TFM_0123456789abcdef0123456789abcdef_SECTION_winOs_END").unwrap()],
            "blocked 1",
        )
        .replace("winOs_END_0", "winOs_END_126");
    let users_start = text.find("winUsers_BEGIN__
").unwrap() + "winUsers_BEGIN__
".len();
    let users_end = text.find("__TFM_0123456789abcdef0123456789abcdef_SECTION_winUsers_END").unwrap();
    let text = format!("{}blocked 1
{}", &text[..users_start], &text[users_end..])
        .replace("winUsers_END_0", "winUsers_END_126");
    let metrics = capture(&mut Reducer::default(), &text);
    assert_eq!(metrics.users, Metric::Unavailable(BLOCKED.into()));
    assert_eq!(metrics.ram, Metric::Unavailable(BLOCKED.into()));
    let Metric::Available(host) = &metrics.host else {
        panic!("{:?}", metrics.host)
    };
    assert_eq!(host.os, Metric::Unavailable(BLOCKED.into()));
}

#[test]
fn windows_users_section_with_no_rows_is_not_zero_users() {
    // CLM with quser blocked by policy: the launch fails, $LASTEXITCODE stays unset and
    // the section ends with exit 0 and no rows. That is a failed read, never "0 users".
    let start = format!("__TFM_{NONCE}_SECTION_winUsers_BEGIN__\n");
    let end = format!("__TFM_{NONCE}_SECTION_winUsers_END_0__");
    let users_start = CAPTURE.find(&start).unwrap() + start.len();
    let users_end = CAPTURE.find(&end).unwrap();
    assert!(users_end > users_start, "fixture has user rows to remove");
    let text = format!("{}{}", &CAPTURE[..users_start], &CAPTURE[users_end..]);
    let metrics = capture(&mut Reducer::default(), &text);
    assert_eq!(
        metrics.users,
        Metric::Unavailable("Invalid Windows metrics fields".into())
    );
    assert!(matches!(capture(&mut Reducer::default(), CAPTURE).users, Metric::Available(_)));
}

#[test]
fn windows_blocked_metadata_reports_policy() {
    for key in ["hostname", "architecture"] {
        let text = section_data(CAPTURE, key, "blocked 1")
            .replace(&format!("{key}_END_0"), &format!("{key}_END_126"));
        let raw = parse(text.as_bytes(), NONCE).unwrap();
        let field = if key == "hostname" { raw.hostname } else { raw.architecture };
        assert_eq!(field, Err(BLOCKED));
        // Exit 126 without a `blocked 1` row stays an ordinary permission failure.
        let text = section_data(CAPTURE, key, "x")
            .replace(&format!("{key}_END_0"), &format!("{key}_END_126"));
        let raw = parse(text.as_bytes(), NONCE).unwrap();
        let field = if key == "hostname" { raw.hostname } else { raw.architecture };
        assert_eq!(field, Err("Permission denied"));
    }
}

#[test]
fn windows_missing_os_identity_preserves_clock_ram_and_cpu() {
    for (exit, reason) in [(0, "Invalid Windows metrics fields"), (1, "Collection command failed")] {
        let text = CAPTURE
            .lines()
            .filter(|row| !row.starts_with("caption ") && !row.starts_with("version "))
            .collect::<Vec<_>>()
            .join("
") + "
";
        let text = text.replace("winOs_END_0", &format!("winOs_END_{exit}"));
        let metrics = capture(&mut Reducer::default(), &text);
        assert!(matches!(metrics.uptime, Metric::Available(_)));
        assert!(matches!(metrics.ram, Metric::Available(_)));
        assert!(matches!(metrics.cpu, Metric::Available(_)));
        let Metric::Available(host) = metrics.host else { panic!("missing host") };
        assert_eq!(host.os, Metric::Unavailable(reason.into()));
    }
}

fn assert_switch_clears_then_rewarms_rates(
    baseline: impl Fn(&mut Reducer),
    switch: impl Fn(&mut Reducer),
    next: impl Fn(&mut Reducer) -> Metrics,
    after: impl Fn(&mut Reducer) -> Metrics,
) {
    for switched in [false, true] {
        let mut reducer = Reducer::default();
        baseline(&mut reducer);
        if switched {
            switch(&mut reducer);
        }
        let metrics = next(&mut reducer);
        assert_eq!(cpu_percent_of(&metrics).is_none(), switched);
        assert_eq!(rate(&metrics.net_up).is_none(), switched);
        assert_eq!(rate(&metrics.net_down).is_none(), switched);
        // The returning sample is the new baseline: the one after it must diff again.
        let metrics = after(&mut reducer);
        assert!(cpu_percent_of(&metrics).is_some(), "switched={switched}");
        assert!(rate(&metrics.net_up).is_some(), "switched={switched}");
        assert!(rate(&metrics.net_down).is_some(), "switched={switched}");
    }
}

#[test]
fn linux_windows_linux_clears_then_rewarms_rates() {
    use crate::ssh::metrics::reduce::tests::sample;
    assert_switch_clears_then_rewarms_rates(
        |r| { sample(r, "10", &[]); },
        |r| { frame(r, 0, 0, "A", 100); },
        |r| sample(r, "12", &[
            ("stat", "cpu 20 0 5 120 30 0 0 0 9 0
btime 1000", 0),
            ("netdev", "eth0: 130 0 0 0 0 0 0 0 260 0 0 0 0 0 0 0", 0),
        ]),
        |r| sample(r, "14", &[
            ("stat", "cpu 30 0 8 180 40 0 0 0 9 0
btime 1000", 0),
            ("netdev", "eth0: 200 0 0 0 0 0 0 0 400 0 0 0 0 0 0 0", 0),
        ]),
    );
}

#[test]
fn windows_linux_windows_clears_then_rewarms_rates() {
    use crate::ssh::metrics::reduce::tests::sample;
    assert_switch_clears_then_rewarms_rates(
        |r| { frame(r, 0, 0, "A", 100); },
        |r| { sample(r, "10", &[]); },
        |r| frame(r, 1, 1, "A", 140),
        |r| frame(r, 2, 2, "A", 180),
    );
}
