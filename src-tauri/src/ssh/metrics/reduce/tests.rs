use super::*;
use crate::ssh::metrics::protocol::parse;

const NONCE: &str = "06900000000000000000000000000002";
const BOOT: &str = "4ddb381e-fa3b-403a-b6b3-ea87b4a45089";
const NEXT_BOOT: &str = "42baccfc-4939-4609-9bed-d5676886fbea";
const LOCAL: &str = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/test ext4 100 20 75 22% /";
const NFS: &str = "Filesystem 1024-blocks Used Available Capacity Mounted on\nremote:/share 200 40 150 22% /srv/share";
const NFS_MOUNTS: &str = "/dev/test / ext4 rw 0 0\nremote:/share /srv/share nfs4 rw 0 0";
const MEM: &str = "MemTotal: 1000 kB\nMemAvailable: 750 kB";
const BASE_STAT: &str = "cpu 10 0 5 100 20 0 0 0 1 0\nbtime 1000";
const SECOND_STAT: &str = "cpu 20 0 5 120 30 0 0 0 9 0\nbtime 1000";
const THIRD_STAT: &str = "cpu 40 0 5 130 40 0 0 0 10 0\nbtime 1000";
const BASE_NET: &str = "eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0";
const SECOND_NET: &str = "eth0: 130 0 0 0 0 0 0 0 260 0 0 0 0 0 0 0";
const THIRD_NET: &str = "eth0: 140 0 0 0 0 0 0 0 300 0 0 0 0 0 0 0";

// These deterministic framed input pairs are derived (synthetic), not captures.
pub(in crate::ssh::metrics) fn sample(reducer: &mut Reducer, uptime: &str, overrides: &[(&str, &str, u8)]) -> Metrics {
    let mut output = format!("__TFM_{NONCE}_V1_BEGIN__\n");
    let linux = overrides.iter().find(|s| s.0 == "platform").is_none_or(|s| s.1 == "Linux" && s.2 == 0);
    let sections = [
        ("platform", "Linux"), ("hostname", "derived-host"), ("architecture", "arm64"),
        ("stat", BASE_STAT), ("meminfo", MEM), ("netdev", BASE_NET), ("uptime", uptime),
        ("bootId", BOOT), ("cpuinfo", "processor : 0"), ("nproc", "4"),
        ("loadavg", "1.25 1.00 0.75 1/10 100"), ("who", "zoe pts/0\nalex pts/1\nzoe pts/2"),
        ("dfLocal", LOCAL), ("dfNfs", ""), ("mounts", "/dev/test / ext4 rw 0 0"), ("fileMounts", ""),
        ("osRelease", "NAME='Derived Linux'\nVERSION_ID=12"),
    ];
    for (key, default) in sections.iter().take(if linux { sections.len() } else { 3 }) {
        use std::fmt::Write;
        let (val, status) = overrides.iter().find(|s| s.0 == *key).map_or((*default, 0), |s| (s.1, s.2));
        writeln!(output, "__TFM_{NONCE}_SECTION_{key}_BEGIN__\n{val}\n__TFM_{NONCE}_SECTION_{key}_END_{status}__").unwrap();
    }
    output.push_str(&format!("__TFM_{NONCE}_V1_END__\n"));
    reducer.reduce(parse(output.as_bytes(), NONCE).unwrap())
}

fn avail<T: std::fmt::Debug>(metric: &Metric<T>) -> &T {
    match metric {
        Metric::Available(value) => value,
        Metric::Unavailable(reason) => panic!("expected available metric: {reason}"),
    }
}

fn cpu(m: &Metrics) -> Option<f64> {
    avail(&m.cpu).percent
}

fn rates(m: &Metrics) -> (Option<f64>, Option<f64>) {
    (avail(&m.net_up).bytes_per_second, avail(&m.net_down).bytes_per_second)
}

fn netrow(name: &str, rx: u64, tx: u64) -> String {
    format!("{name}: {rx} 0 0 0 0 0 0 0 {tx} 0 0 0 0 0 0 0")
}

#[test]
fn cpu_guest_is_not_counted_twice() {
    let mut r = Reducer::default();
    sample(&mut r, "10", &[]);
    // Guest delta 8 is included in user delta 10. Busy 10 / total 40.
    assert_eq!(cpu(&sample(&mut r, "12", &[("stat", SECOND_STAT, 0)])), Some(25.0));
    // Same guest, user +20, idle +10, iowait +10: 20 of 40, not 30 of 40.
    assert_eq!(cpu(&sample(&mut r, "14", &[("stat", "cpu 40 0 5 130 40 0 0 0 9 0", 0)])), Some(50.0));
}

#[test]
fn first_cpu_and_network_sample_is_null_not_zero() {
    let mut r = Reducer::default();
    let first = sample(&mut r, "10", &[]);
    assert_eq!(cpu(&first), None);
    assert_eq!(rates(&first), (None, None));
    let second = sample(&mut r, "12", &[("stat", SECOND_STAT, 0), ("netdev", SECOND_NET, 0)]);
    assert_eq!(cpu(&second), Some(25.0));
    assert_eq!(rates(&second), (Some(30.0), Some(15.0)));
    let third = sample(&mut r, "14", &[("stat", THIRD_STAT, 0), ("netdev", THIRD_NET, 0)]);
    assert_eq!(cpu(&third), Some(50.0));
    assert_eq!(rates(&third), (Some(20.0), Some(5.0)));
}

#[test]
fn network_tx_is_upload_rx_download_excludes_only_lo() {
    let mut r = Reducer::default();
    let first = format!("{BASE_NET}\n{}\n{}\n{}", netrow("lo", 0, 0), netrow("veth1", 10, 20), netrow("br0", 20, 40));
    let second = format!("{SECOND_NET}\n{}\n{}\n{}", netrow("lo", u64::MAX, u64::MAX), netrow("veth1", 16, 40), netrow("br0", 24, 44));
    sample(&mut r, "10", &[("netdev", &first, 0)]);
    assert_eq!(rates(&sample(&mut r, "12", &[("netdev", &second, 0)])), (Some(42.0), Some(20.0)));
    let swapped = format!("{THIRD_NET}\n{}\n{}", netrow("veth2", 5000, 6000), netrow("br0", 26, 46));
    assert_eq!(rates(&sample(&mut r, "14", &[("netdev", &swapped, 0)])), (None, None));
    assert_eq!(rates(&sample(&mut r, "16", &[("netdev", &swapped, 0)])), (Some(0.0), Some(0.0)));
}

#[test]
fn rates_use_actual_three_second_remote_elapsed() {
    let mut r = Reducer::default();
    sample(&mut r, "100", &[]);
    assert_eq!(rates(&sample(&mut r, "103", &[("netdev", SECOND_NET, 0)])), (Some(20.0), Some(10.0)));
    let fractional = netrow("eth0", 135, 275);
    assert_eq!(rates(&sample(&mut r, "104.25", &[("netdev", &fractional, 0)])), (Some(12.0), Some(4.0)));
    let later = netrow("eth0", 635, 1275);
    assert_eq!(rates(&sample(&mut r, "154.25", &[("netdev", &later, 0)])), (Some(20.0), Some(10.0)));
}

#[test]
fn u64_wrap_has_exact_small_delta_without_overflow() {
    let mut r = Reducer::default();
    let high = netrow("eth0", u64::MAX - 5, u64::MAX - 11);
    let low = netrow("eth0", 2, 4);
    sample(&mut r, "10", &[("netdev", &high, 0)]);
    assert_eq!(rates(&sample(&mut r, "12", &[("netdev", &low, 0)])), (Some(8.0), Some(4.0)));
    // Exactly one increment from MAX to zero. The other direction stays level.
    r.reset();
    sample(&mut r, "20", &[("netdev", &netrow("eth0", 80, u64::MAX), 0)]);
    assert_eq!(rates(&sample(&mut r, "21", &[("netdev", &netrow("eth0", 80, 0), 0)])), (Some(1.0), Some(0.0)));
    // Same high-to-low shape is not a wrap across a reboot or without identity.
    for (new_id, new_id_exit) in [(NEXT_BOOT, 0), ("", 127)] {
        r.reset();
        sample(&mut r, "10", &[("netdev", &high, 0), ("stat", "cpu 10 0 5 100", 0)]);
        assert_eq!(rates(&sample(&mut r, "12", &[("netdev", &low, 0), ("bootId", new_id, new_id_exit), ("stat", "cpu 20 0 5 120", 0)])), (None, None));
    }
    r.reset();
    sample(&mut r, "10", &[("netdev", &netrow("eth0", 13_835_058_055_282_163_711, u64::MAX), 0)]);
    assert_eq!(rates(&sample(&mut r, "12", &[("netdev", &netrow("eth0", 0, 4_611_686_018_427_387_904), 0)])), (None, None));
}

#[test]
fn ambiguous_32bit_decrease_rebaselines_instead_of_guessing_wrap() {
    let mut r = Reducer::default();
    sample(&mut r, "10", &[("netdev", &netrow("eth0", 4_294_967_293, 200), 0)]);
    assert_eq!(rates(&sample(&mut r, "12", &[("netdev", &netrow("eth0", 3, 220), 0)])), (Some(10.0), None));
    assert_eq!(rates(&sample(&mut r, "14", &[("netdev", &netrow("eth0", 19, 240), 0)])), (Some(10.0), Some(8.0)));
    sample(&mut r, "16", &[("netdev", &netrow("eth0", u64::MAX - 2, 260), 0)]);
    assert_eq!(rates(&sample(&mut r, "18", &[("netdev", &netrow("eth0", 3, 280), 0)])), (Some(10.0), Some(3.0)));
}

#[test]
fn reboot_with_new_boot_id_and_higher_uptime_resets_rates() {
    let mut r = Reducer::default();
    sample(&mut r, "10", &[]);
    let reboot = sample(&mut r, "100", &[("bootId", NEXT_BOOT, 0), ("stat", SECOND_STAT, 0), ("netdev", SECOND_NET, 0)]);
    assert_eq!(cpu(&reboot), None);
    assert_eq!(rates(&reboot), (None, None));
    let stable = sample(&mut r, "102", &[("bootId", NEXT_BOOT, 0), ("stat", THIRD_STAT, 0), ("netdev", THIRD_NET, 0)]);
    assert_eq!(cpu(&stable), Some(50.0));
    assert_eq!(rates(&stable), (Some(20.0), Some(5.0)));
}

#[test]
fn btime_drift_with_the_same_boot_id_keeps_rates() {
    // Linux derives btime from the wall clock minus uptime, so a stepped host clock
    // (NTP, WSL2 host time sync) moves it without a reboot. Observed live on WSL2:
    // +1 s and +2 s within one minute, each resetting CPU and network to "...".
    let mut r = Reducer::default();
    sample(&mut r, "10", &[]);
    let drifted = sample(&mut r, "12", &[("stat", &SECOND_STAT.replace("1000", "1001"), 0), ("netdev", SECOND_NET, 0)]);
    assert_eq!(cpu(&drifted), Some(25.0));
    assert_eq!(rates(&drifted), (Some(30.0), Some(15.0)));
    let back = sample(&mut r, "14", &[("stat", &THIRD_STAT.replace("1000", "999"), 0), ("netdev", THIRD_NET, 0)]);
    assert_eq!(cpu(&back), Some(50.0));
    assert_eq!(rates(&back), (Some(20.0), Some(5.0)));
}

#[test]
fn missing_boot_id_uses_btime_and_uptime() {
    let mut r = Reducer::default();
    sample(&mut r, "10", &[("bootId", "", 1)]);
    let stable = sample(&mut r, "12", &[("bootId", "", 1), ("stat", SECOND_STAT, 0), ("netdev", SECOND_NET, 0)]);
    assert_eq!(cpu(&stable), Some(25.0));
    assert_eq!(rates(&stable), (Some(30.0), Some(15.0)));
    let reboot = sample(&mut r, "14", &[("bootId", "", 1), ("stat", &THIRD_STAT.replace("1000", "1001"), 0), ("netdev", THIRD_NET, 0)]);
    assert_eq!(cpu(&reboot), None);
    assert_eq!(rates(&reboot), (None, None));
    let regressed = sample(&mut r, "2", &[("bootId", "", 1), ("stat", "cpu 60 0 5 150 40\nbtime 1001", 0), ("netdev", THIRD_NET, 0)]);
    assert_eq!(cpu(&regressed), None);
    assert_eq!(rates(&regressed), (None, None));
}

#[test]
fn interface_added_removed_or_reset_cannot_spike() {
    let mut r = Reducer::default();
    sample(&mut r, "2", &[]);
    let added = format!("{SECOND_NET}\n{}", netrow("eth1", 999, 999));
    assert_eq!(rates(&sample(&mut r, "4", &[("netdev", &added, 0)])), (None, None));
    assert_eq!(rates(&sample(&mut r, "6", &[("netdev", THIRD_NET, 0)])), (None, None));
    assert_eq!(rates(&sample(&mut r, "8", &[("netdev", BASE_NET, 0)])), (None, None));
    assert_eq!(rates(&sample(&mut r, "10", &[("netdev", SECOND_NET, 0)])), (Some(30.0), Some(15.0)));
}

#[test]
fn iowait_decrease_does_not_wrap() {
    let mut r = Reducer::default();
    sample(&mut r, "1", &[]);
    assert_eq!(cpu(&sample(&mut r, "3", &[("stat", SECOND_STAT, 0)])), Some(25.0));
    assert_eq!(cpu(&sample(&mut r, "5", &[("stat", "cpu 40 0 5 130 29", 0)])), None);
    assert_eq!(cpu(&sample(&mut r, "7", &[("stat", "cpu 50 0 5 135 34", 0)])), Some(50.0));
}

#[test]
fn zero_elapsed_or_total_delta_is_unavailable() {
    let mut r = Reducer::default();
    sample(&mut r, "10", &[]);
    let zero_elapsed = sample(&mut r, "10", &[("stat", SECOND_STAT, 0), ("netdev", SECOND_NET, 0)]);
    assert_eq!(zero_elapsed.net_up, Metric::Unavailable("Remote uptime did not advance".into()));
    assert_eq!(zero_elapsed.net_down, Metric::Unavailable("Remote uptime did not advance".into()));
    assert_eq!(cpu(&zero_elapsed), Some(25.0));
    let warm = sample(&mut r, "12", &[("stat", THIRD_STAT, 0), ("netdev", THIRD_NET, 0)]);
    assert_eq!(cpu(&warm), Some(50.0));
    assert_eq!(rates(&warm), (None, None));
    let stalled = sample(&mut r, "14", &[("stat", THIRD_STAT, 0), ("netdev", &netrow("eth0", 160, 340), 0)]);
    assert_eq!(stalled.cpu, Metric::Unavailable("CPU counters did not advance".into()));
    assert_eq!(rates(&stalled), (Some(20.0), Some(10.0)));
}

#[test]
fn memavailable_and_old_kernel_fallback_have_exact_byte_oracles() {
    let mut r = Reducer::default();
    let preferred = sample(&mut r, "10", &[("meminfo", &format!("{MEM}\nMemFree: 1 kB"), 0)]);
    assert_eq!(*avail(&preferred.ram), Ram { used_bytes: 256000, total_bytes: 1024000, percent: 25.0 });
    let old = "MemTotal: 200 kB\nMemFree: 20 kB\nBuffers: 10 kB\nCached: 55 kB\nSReclaimable: 25 kB\nShmem: 10 kB";
    assert_eq!(*avail(&sample(&mut r, "11", &[("meminfo", old, 0)]).ram), Ram { used_bytes: 102400, total_bytes: 204800, percent: 50.0 });
    let bounded = old.replace("Cached: 55", "Cached: 255");
    assert_eq!(avail(&sample(&mut r, "12", &[("meminfo", &bounded, 0)]).ram).used_bytes, 0);
    let negative = old.replace("Shmem: 10", "Shmem: 120");
    assert_eq!(avail(&sample(&mut r, "13", &[("meminfo", &negative, 0)]).ram).used_bytes, 204800);
    for bad in [old.replace("\nShmem: 10 kB", ""), old.replace("Cached: 55", "Cached: 18446744073709551615").replace("Shmem: 10", "Shmem: 18446744073709551615"), old.replace("MemTotal: 200", "MemTotal: 0"), old.replace("MemTotal: 200", "MemTotal: 18014398509481984")] {
        assert!(matches!(sample(&mut r, "14", &[("meminfo", &bad, 0)]).ram, Metric::Unavailable(_)));
    }
}

#[test]
fn failed_metric_clears_its_baseline_and_keeps_other_metrics() {
    let mut r = Reducer::default();
    sample(&mut r, "10", &[]);
    let net_failed = sample(&mut r, "12", &[("stat", SECOND_STAT, 0), ("netdev", SECOND_NET, 1)]);
    assert!(matches!(net_failed.net_up, Metric::Unavailable(_)));
    assert_eq!(cpu(&net_failed), Some(25.0));
    let warm = sample(&mut r, "14", &[("stat", THIRD_STAT, 0), ("netdev", THIRD_NET, 0)]);
    assert_eq!(rates(&warm), (None, None));
    assert_eq!(cpu(&warm), Some(50.0));
    let high = netrow("eth0", 152, 332);
    let cpu_failed = sample(&mut r, "16", &[("stat", THIRD_STAT, 1), ("netdev", &high, 0)]);
    assert!(matches!(cpu_failed.cpu, Metric::Unavailable(_)));
    assert_eq!(rates(&cpu_failed), (Some(16.0), Some(6.0)));
    let higher = netrow("eth0", 168, 352);
    let revived = sample(&mut r, "18", &[("stat", BASE_STAT, 0), ("netdev", &higher, 0)]);
    assert_eq!(cpu(&revived), None);
    assert_eq!(rates(&revived), (Some(10.0), Some(8.0)));
    let recovered = sample(&mut r, "20", &[("stat", SECOND_STAT, 0), ("netdev", &higher, 0), ("meminfo", MEM, 1)]);
    assert!(matches!(recovered.ram, Metric::Unavailable(_)));
    assert_eq!(cpu(&recovered), Some(25.0));
    assert_eq!(rates(&recovered), (Some(0.0), Some(0.0)));
}

#[test]
fn empty_nfs_is_available_but_failed_df_is_not() {
    let mut r = Reducer::default();
    assert!(avail(&sample(&mut r, "1", &[]).nfs).mounts.is_empty());
    assert!(matches!(sample(&mut r, "2", &[("dfNfs", NFS, 1), ("mounts", NFS_MOUNTS, 0)]).nfs, Metric::Unavailable(_)));
    let full = sample(&mut r, "3", &[("dfNfs", NFS, 0), ("mounts", NFS_MOUNTS, 0)]);
    assert_eq!(avail(&full.nfs).mounts, [MountUsage { source: "remote:/share".into(), mount_point: "/srv/share".into(), fs_type: "nfs4".into(), total_bytes: 204800, used_bytes: 40960, available_bytes: 153600, used_percent: 22 }]);
}

#[test]
fn watchdog_keeps_completed_gauges_without_carrying_any_baseline() {
    let mut r = Reducer::default();
    sample(&mut r, "10", &[]);
    let expired = sample(&mut r, "12", &[("stat", SECOND_STAT, 0), ("netdev", SECOND_NET, 0), ("dfNfs", NFS, 137), ("mounts", NFS_MOUNTS, 0)]);
    assert_eq!(cpu(&expired), None);
    assert_eq!(rates(&expired), (None, None));
    assert_eq!(avail(&expired.partitions).mounts[0].total_bytes, 102400);
    assert_eq!(expired.nfs, Metric::Unavailable("NFS usage watchdog expired".into()));
    let warm = sample(&mut r, "14", &[("stat", THIRD_STAT, 0), ("netdev", THIRD_NET, 0)]);
    assert_eq!(cpu(&warm), None);
    assert_eq!(rates(&warm), (None, None));
}

#[test]
fn cpu_core_metadata_falls_back_without_fabricating_values() {
    let mut r = Reducer::default();
    let cpuinfo = [("nproc", "", 127), ("cpuinfo", "processor : 0\nprocessor : 1", 0)];
    assert_eq!(avail(&avail(&sample(&mut r, "10", &cpuinfo).cpu).cores).count, 2);
    let stat = [("nproc", "", 127), ("cpuinfo", "Processor: generic", 0), ("stat", "cpu 30 0 5 120\ncpu0 30 0 5 120", 0)];
    assert_eq!(avail(&avail(&sample(&mut r, "12", &stat).cpu).cores).count, 1);
    let bad = [("nproc", "0", 0), ("cpuinfo", "Processor: generic", 0), ("stat", "cpu 40 0 5 130", 0)];
    assert!(matches!(avail(&sample(&mut r, "14", &bad).cpu).cores, Metric::Unavailable(_)));
}

#[test]
fn numeric_input_overflow_fails_independently() {
    let mut r = Reducer::default();
    let bad = "18446744073709551616";
    let cpu_row = format!("cpu {bad} 0 5 120");
    let m = sample(&mut r, "10", &[("stat", &cpu_row, 0)]);
    assert!(matches!(m.cpu, Metric::Unavailable(_)));
    assert_eq!(rates(&m), (None, None));
    let net_row = format!("eth0: {bad} 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0");
    let m = sample(&mut r, "12", &[("netdev", &net_row, 0)]);
    assert_eq!(cpu(&m), None);
    assert!(matches!(m.net_down, Metric::Unavailable(_)));
    assert_eq!(avail(&m.uptime).seconds, 12.0);
}

mod darwin_tests {
    use super::*;
    const N: &str = "07100000000000000000000000000001";
    const FIXTURE: &str = include_str!("../fixtures/darwin.txt");
    fn read(text: &str, reducer: &mut Reducer, started: std::time::Instant) -> Metrics {
        reducer.reduce_at(parse(text.as_bytes(), N).unwrap(), started)
    }
    #[test]
    fn darwin_capture_parses_every_section_with_exact_values() {
        let raw = parse(FIXTURE.as_bytes(), N).unwrap();
        assert_eq!(raw.platform, crate::ssh::metrics::protocol::Platform::Darwin);
        assert_eq!(raw.os.clone().unwrap(), "macOS 26.5.2");
        assert_eq!(raw.hostname.clone().unwrap(), "mac-host.local");
        assert_eq!(raw.architecture.as_deref(), Ok("arm64"));
        assert_eq!(raw.nfs.as_ref().unwrap(), &[]);
        assert!(!raw.nfs_watchdog_expired);
        let source: Vec<_> = include_str!("../fixtures/darwin-commands.txt").lines().collect();
        for (key, range) in [("swVers", 3..6), ("ncpu", 7..8), ("memsize", 8..9), ("pagesize", 9..10), ("boottime", 10..11), ("loadavg", 11..12), ("now", 13..14)] {
            let section = raw.section(key).unwrap();
            assert_eq!(section.exit, 0, "{key}");
            assert_eq!(section.rows().unwrap(), &source[range], "{key}");
        }
        let boundaries: Vec<_> = ["Mach Virtual", "Name ", "user1", "Filesystem ", "/dev/disk3s1s1 on", "CPU usage:"].iter().map(|prefix| source.iter().position(|s| s.starts_with(prefix)).unwrap()).collect();
        for (i, key) in ["vmstat", "netstat", "who", "dfLocal", "mounts"].iter().enumerate() {
            let section = raw.section(key).unwrap();
            assert_eq!(section.exit, 0);
            assert_eq!(section.rows().unwrap(), &source[boundaries[i]..boundaries[i+1]], "{key}");
        }
        assert_eq!(raw.section("dfNfs").unwrap().exit, 0);
        assert!(raw.section("dfNfs").unwrap().rows().unwrap().is_empty());
        let cpu_rows = raw.section("iostat").unwrap();
        assert_eq!(cpu_rows.exit, 0);
        assert_eq!(cpu_rows.rows().unwrap(), ["              disk0              disk1              disk2       cpu    load average", "    KB/t  tps  MB/s     KB/t  tps  MB/s     KB/t  tps  MB/s  us sy id   1m   5m   15m", "   16.00   24  0.37     0.00    0  0.00     0.00    0  0.00  20 10 70  3.97 5.31 4.42", "   16.00   24  0.37     0.00    0  0.00     0.00    0  0.00  10  4 86  3.97 5.31 4.42"]);
        let expected = [
            ("/dev/disk3s1s1", "/", "apfs", 482797652, 12276964, 51455472, 20),
            ("/dev/disk11s1", "/Volumes/Volume One", "hfs", 87360, 72440, 14920, 83),
            ("/dev/disk7s1", "/Volumes/AppDisk 1.0", "apfs", 9728, 7572, 1812, 81),
            ("/dev/disk8s1", "/Volumes/USB Drive", "exfat", 125308160, 19290752, 106017408, 16),
        ];
        let actual = raw.local.unwrap();
        assert_eq!(actual, expected.map(|(source, point, fs, total, used, free, percent)| MountUsage { source: source.into(), mount_point: point.into(), fs_type: fs.into(), total_bytes: total*1024, used_bytes: used*1024, available_bytes: free*1024, used_percent: percent }));
    }
    #[test]
    fn darwin_cpu_is_available_on_first_sample() {
        let m = read(FIXTURE, &mut Reducer::default(), std::time::Instant::now());
        assert_eq!(avail(&m.cpu).percent, Some(14.0));
        assert_eq!(avail(&avail(&m.cpu).cores).count, 14);
        assert_eq!(avail(&avail(&m.cpu).load1).value, 4.05);
    }
    #[test]
    fn darwin_ram_matches_activity_monitor_formula() {
        let m = read(FIXTURE, &mut Reducer::default(), std::time::Instant::now());
        assert_eq!(avail(&m.ram).used_bytes, (352705 + 401644 + 305892) * 16384);
        assert_eq!(avail(&m.ram).total_bytes, 38654705664);
        assert_eq!(avail(&m.users).count, 4);
        assert_eq!(avail(&m.uptime).seconds, (1795458834u64 - 1788608901) as f64);
    }
    #[test]
    fn vm_stat_page_size_mismatch_is_unavailable() {
        let s = FIXTURE.replace("page size of 16384", "page size of 4096");
        assert!(matches!(read(&s, &mut Reducer::default(), std::time::Instant::now()).ram, Metric::Unavailable(_)));
    }
    #[test]
    fn mount_nobrowse_and_system_volumes_are_not_local() {
        let raw = parse(FIXTURE.as_bytes(), N).unwrap();
        let mounts = raw.local.unwrap();
        assert_eq!(mounts.iter().map(|m| m.mount_point.as_str()).collect::<Vec<_>>(), ["/", "/Volumes/Volume One", "/Volumes/AppDisk 1.0", "/Volumes/USB Drive"]);
    }
    #[test]
    fn unknown_fs_type_makes_partitions_unavailable() {
        let s = FIXTURE.replace("(exfat,", "(futurefs,");
        assert!(parse(s.as_bytes(), N).unwrap().local.is_err());
    }
    #[test]
    fn darwin_and_linux_sections_are_mutually_exclusive() {
        let s = FIXTURE.replace(&format!("__TFM_{N}_V1_END__"), &format!("__TFM_{N}_SECTION_stat_BEGIN__
cpu 1 2 3 4
__TFM_{N}_SECTION_stat_END_0__
__TFM_{N}_V1_END__"));
        assert!(parse(s.as_bytes(), N).is_err());
    }
    #[test]
    fn netstat_takes_only_link_rows_and_skips_lo0() {
        let raw = parse(FIXTURE.as_bytes(), N).unwrap();
        let map = super::super::darwin::interfaces(&raw).unwrap();
        assert!(!map.contains_key("lo0"));
        assert!(!map.keys().any(|s| s.ends_with('*')));
        assert_eq!(map["en0"], [3342652065, 2440182655]);
    }
    #[test]
    fn darwin_network_rate_uses_local_exec_start_and_resets_on_interface_change() {
        let start = std::time::Instant::now();
        let cadence = crate::ssh::metrics::sampler::CADENCE;
        let mut r = Reducer::default();
        assert_eq!(avail(&read(FIXTURE, &mut r, start).net_up).bytes_per_second, None);
        let s = FIXTURE.replace("2440182655", "2440183655");
        let m = read(&s, &mut r, start + cadence);
        assert_eq!(avail(&m.net_up).bytes_per_second, Some(1000.0 / cadence.as_secs_f64()));
        let s = s.replace("en0 ", "new0 ");
        assert_eq!(avail(&read(&s, &mut r, start + cadence * 2).net_up).bytes_per_second, None);
    }
    #[test]
    fn darwin_reboot_resets_baselines() {
        let start = std::time::Instant::now();
        let mut r = Reducer::default(); read(FIXTURE, &mut r, start);
        let s = FIXTURE.replace("1788608901", "1788608902");
        assert_eq!(avail(&read(&s, &mut r, start + crate::ssh::metrics::sampler::CADENCE).net_up).bytes_per_second, None);
    }
    #[test]
    fn darwin_metadata_is_bounded_and_network_rejects_truncated_link_rows() {
        let text = FIXTURE.replace("macOS", &format!("mac	{}", "x".repeat(300)));
        let raw = parse(text.as_bytes(), N).unwrap();
        let os = raw.os.unwrap(); assert_eq!(os.len(), 256); assert!(!os.contains('\t'));
        for row in ["en0 1500 <Link#20> 1 2 3 4 5", "en0 1500 <Link#20> 1 2 3 4 5 6"] {
            let start = FIXTURE.find("en0        1500  <Link#20>").unwrap();
            let end = start + FIXTURE[start..].find('\n').unwrap();
            let text = format!("{}{row}{}", &FIXTURE[..start], &FIXTURE[end..]);
            assert!(super::super::darwin::interfaces(&parse(text.as_bytes(), N).unwrap()).is_err());
        }
    }
    #[test]
    fn darwin_sections_are_rejected_on_linux_and_unsupported_hosts() {
        for platform in ["Linux", "FreeBSD"] {
            let mut lines = Vec::new();
            lines.push(format!("__TFM_{N}_V1_BEGIN__"));
            let linux_sections = ["stat", "meminfo", "netdev", "uptime", "bootId", "cpuinfo", "nproc", "loadavg", "who", "dfLocal", "dfNfs", "mounts", "fileMounts", "osRelease"];
            let mut keys = vec!["platform", "hostname", "architecture", "iostat"];
            if platform == "Linux" { keys.extend(linux_sections); }
            for key in keys { lines.push(format!("__TFM_{N}_SECTION_{key}_BEGIN__
{platform}
__TFM_{N}_SECTION_{key}_END_0__")); }
            lines.push(format!("__TFM_{N}_V1_END__
"));
            assert!(parse(lines.join("
").as_bytes(), N).is_err());
        }
    }

}
