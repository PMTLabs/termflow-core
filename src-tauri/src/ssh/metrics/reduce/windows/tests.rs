use super::*;
use crate::ssh::metrics::{protocol::parse, reduce::Reducer, sampler::CADENCE};

const NONCE: &str = "0123456789abcdef0123456789abcdef";
const CAPTURE: &str = include_str!("../../fixtures/windows.txt");
const BOOT: &str = "20261111034830.135220-360";

fn capture(reducer: &mut Reducer, text: &str) -> Metrics {
    reducer.reduce(parse(text.as_bytes(), NONCE).unwrap())
}

fn frame(reducer: &mut Reducer, n: u64, adapter: &str, boot: &str, rx: u64) -> Metrics {
    let ticks = CADENCE.as_nanos() as u64 / 100;
    let text = CAPTURE
        .replace("6096216194881", &(100 + n * ticks / 4).to_string())
        .replace(
            "134399337457267717",
            &(900_000_000_000 + n * ticks).to_string(),
        )
        .replace(BOOT, boot);
    let (begin, rest) = text.split_once("_SECTION_winNet_BEGIN__\n").unwrap();
    let (_, end) = rest
        .split_once(&format!("__TFM_{NONCE}_SECTION_winNet_END_"))
        .unwrap();
    // The TCP/IP clock has a different epoch and the actual interval here is twice the nominal cadence.
    let ts = 12_000_000_000 + n * 2 * ticks;
    let tx = 200 + n * 6 * CADENCE.as_secs();
    let text = format!("{begin}_SECTION_winNet_BEGIN__\n{rx} {tx} {ts} {adapter}\n__TFM_{NONCE}_SECTION_winNet_END_{end}");
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
    assert_eq!(cpu_percent_of(&frame(&mut reducer, 0, "A", BOOT, 0)), None);
    assert_eq!(
        cpu_percent_of(&frame(&mut reducer, 1, "A", BOOT, 1)),
        Some(75.0)
    );
    assert_eq!(cpu_percent_of(&frame(&mut reducer, 0, "A", BOOT, 2)), None);
}

#[test]
fn windows_network_rate_uses_its_own_class_timestamp() {
    let mut reducer = Reducer::default();
    assert_eq!(rate(&frame(&mut reducer, 0, "A", BOOT, 100).net_down), None);
    let next = frame(&mut reducer, 1, "A", BOOT, 100 + 4 * CADENCE.as_secs());
    assert_eq!(
        (rate(&next.net_down), rate(&next.net_up)),
        (Some(2.0), Some(3.0))
    );
}

#[test]
fn windows_instance_set_change_resets_baseline() {
    let mut reducer = Reducer::default();
    frame(&mut reducer, 0, "A", BOOT, 100);
    assert_eq!(rate(&frame(&mut reducer, 1, "B", BOOT, 110).net_down), None);
    assert_eq!(rate(&frame(&mut reducer, 2, "B", BOOT, 10).net_down), None);
    assert_eq!(
        rate(&frame(&mut reducer, 3, "B", BOOT, 10 + 4 * CADENCE.as_secs()).net_down),
        Some(2.0)
    );
}

#[test]
fn windows_boot_change_resets_baselines() {
    let mut reducer = Reducer::default();
    frame(&mut reducer, 0, "A", BOOT, 0);
    let same_boot = frame(&mut reducer, 1, "A", "20261111094830.135220+000", 1);
    assert_eq!(cpu_percent_of(&same_boot), Some(75.0));
    assert!(rate(&same_boot.net_down).is_some());
    let other_boot = frame(&mut reducer, 2, "A", "20261111034831.135220-360", 2);
    assert_eq!(cpu_percent_of(&other_boot), None);
    assert_eq!(rate(&other_boot.net_down), None);
}

#[test]
fn windows_load1_is_unavailable_with_reason() {
    let metrics = capture(&mut Reducer::default(), CAPTURE);
    assert_eq!(metrics.platform, Some("Windows"));
    assert_eq!(metrics.unsupported_platform, None);
    let Metric::Available(cpu) = metrics.cpu else {
        panic!("CPU should be available")
    };
    assert_eq!(
        cpu.load1,
        Metric::Unavailable("Load average is not available on Windows".into())
    );
    assert_eq!(cpu.cores, Metric::Available(Cores { count: 24 }));
}

#[test]
fn windows_ram_formula() {
    let metrics = capture(&mut Reducer::default(), CAPTURE);
    let (total, free) = (133565024_u64, 35257884_u64);
    assert_eq!(
        metrics.ram,
        Metric::Available(Ram {
            total_bytes: total * 1024,
            used_bytes: (total - free) * 1024,
            percent: 100.0 * (total - free) as f64 / total as f64,
        })
    );
    assert_eq!(
        metrics.uptime,
        Metric::Available(Uptime {
            seconds: 1_069_635.442_78
        })
    );
}
