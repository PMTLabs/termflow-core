use super::*;
use crate::ssh::metrics::reduce::{tests::sample, Reducer};
use serde_json::{json, to_value};

#[test]
fn snapshot_json_has_nine_camelcase_metric_keys_plus_only_the_platform_label_and_finite_values() {
    let mut reducer = Reducer::default();
    let first = MetricsSnapshot {
        terminal_id: "derived-A".into(),
        sampled_at: 125,
        metrics: sample(&mut reducer, "12.25", &[]),
    };
    let a = to_value(first).unwrap();
    assert_eq!(a, json!({
        "terminalId": "derived-A", "sampledAt": 125, "metrics": {
            "host": {"available": true, "hostname": "derived-host",
                "os": {"available": true, "name": "Derived Linux 12"},
                "architecture": {"available": true, "name": "arm64"}},
            "cpu": {"available": true, "percent": null,
                "cores": {"available": true, "count": 4}, "load1": {"available": true, "value": 1.25}},
            "ram": {"available": true, "usedBytes": 256000, "totalBytes": 1024000, "percent": 25.0},
            "netUp": {"available": true, "bytesPerSecond": null},
            "netDown": {"available": true, "bytesPerSecond": null},
            "uptime": {"available": true, "seconds": 12.25},
            "users": {"available": true, "count": 3, "names": ["alex", "zoe"]},
            "partitions": {"available": true, "mounts": [{"source": "/dev/test", "mountPoint": "/",
                "fsType": "ext4", "totalBytes": 102400, "usedBytes": 20480, "availableBytes": 76800, "usedPercent": 22}]},
            "nfs": {"available": true, "mounts": []}
        }
    }));

    let nonfinite = "9".repeat(350);
    let next = MetricsSnapshot {
        terminal_id: "derived-A".into(),
        sampled_at: 2115,
        metrics: sample(&mut reducer, "14.25", &[
            ("hostname", "derived-next", 0), ("osRelease", "NAME=OnlyName", 0),
            ("architecture", "", 1), ("stat", "cpu 20 0 5 110 20\nbtime 1000", 0),
            ("nproc", "", 127), ("cpuinfo", "", 1), ("loadavg", &nonfinite, 0),
            ("netdev", "eth0: 160 0 0 0 0 0 0 0 240 0 0 0 0 0 0 0", 0),
            ("meminfo", "", 1), ("who", "", 0), ("dfNfs", "partial stdout", 1),
        ]),
    };
    let b = to_value(next).unwrap();
    assert_eq!(b, json!({
        "terminalId": "derived-A", "sampledAt": 2115, "metrics": {
            "host": {"available": true, "hostname": "derived-next",
                "os": {"available": false, "reason": "Remote OS metadata unavailable"},
                "architecture": {"available": false, "reason": "Collection command failed"}},
            "cpu": {"available": true, "percent": 50.0,
                "cores": {"available": false, "reason": "CPU core count unavailable"},
                "load1": {"available": false, "reason": "Invalid load average"}},
            "ram": {"available": false, "reason": "Collection command failed"},
            "netUp": {"available": true, "bytesPerSecond": 20.0},
            "netDown": {"available": true, "bytesPerSecond": 30.0},
            "uptime": {"available": true, "seconds": 14.25},
            "users": {"available": true, "count": 0, "names": []},
            "partitions": {"available": true, "mounts": [{"source": "/dev/test", "mountPoint": "/",
                "fsType": "ext4", "totalBytes": 102400, "usedBytes": 20480, "availableBytes": 76800, "usedPercent": 22}]},
            "nfs": {"available": false, "reason": "Collection command failed"}
        }
    }));

    let unsupported = to_value(sample(&mut reducer, "", &[("platform", "FreeBSD", 0)])).unwrap();
    assert_eq!(unsupported.as_object().unwrap().len(), 10);
    assert_eq!(unsupported["unsupportedPlatform"], json!("FreeBSD"));
    assert_eq!(unsupported["host"], json!({"available": true, "hostname": "derived-host",
        "os": {"available": true, "name": "FreeBSD"}, "architecture": {"available": true, "name": "arm64"}}));
    for key in ["cpu", "ram", "netUp", "netDown", "uptime", "users", "partitions", "nfs"] {
        assert_eq!(unsupported[key], json!({"available": false, "reason": "Metrics are supported only on Linux and macOS (FreeBSD)"}));
    }
    // An unknown platform is not "unsupported": nothing names it, and Host keeps its own reading.
    let unknown = to_value(sample(&mut reducer, "", &[("platform", "", 1)])).unwrap();
    assert!(unknown.get("unsupportedPlatform").is_none());
    assert_eq!(unknown.as_object().unwrap().len(), 9);
    assert_eq!(unknown["host"], json!({"available": true, "hostname": "derived-host",
        "os": {"available": false, "reason": "Remote OS metadata unavailable"}, "architecture": {"available": true, "name": "arm64"}}));
    assert_eq!(unknown["cpu"], json!({"available": false, "reason": "Remote platform unavailable"}));
    let after = to_value(sample(&mut reducer, "16", &[])).unwrap();
    assert_eq!(after["cpu"]["percent"], json!(null));
    assert_eq!(after["netUp"]["bytesPerSecond"], json!(null));
}

#[test]
fn whole_sample_unavailable_has_explicit_reason_without_unsupported_label() {
    for reason in ["Metrics collector unavailable", "Metrics command failed", "Metrics exec unavailable"] {
        let value = to_value(Metrics::unavailable(reason)).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 10);
        assert_eq!(value["unavailableReason"], json!(reason));
        assert!(value.get("unsupportedPlatform").is_none());
        for key in ["host", "cpu", "ram", "netUp", "netDown", "uptime", "users", "partitions", "nfs"] {
            assert_eq!(value[key], json!({"available": false, "reason": reason}));
        }
    }
}

#[test]
fn a_parsed_sample_that_measured_nothing_is_flagged_unavailable() {
    let mut reducer = Reducer::default();
    // An unknown platform whose hostname also failed: every metric, Host included, is n/a.
    let unknown = to_value(sample(&mut reducer, "", &[("platform", "", 1), ("hostname", "", 1)])).unwrap();
    assert_eq!(unknown.as_object().unwrap().len(), 10);
    assert_eq!(unknown["unavailableReason"], json!("Remote platform unavailable"));
    assert!(unknown.get("unsupportedPlatform").is_none());

    // Linux with every section failing.
    let keys = ["platform", "hostname", "architecture", "stat", "meminfo", "netdev", "uptime", "bootId", "cpuinfo",
        "nproc", "loadavg", "who", "dfLocal", "dfNfs", "mounts", "fileMounts", "osRelease"];
    let failed: Vec<_> = keys.iter().filter(|k| **k != "platform").map(|k| (*k, "", 1)).collect();
    let linux = to_value(sample(&mut Reducer::default(), "", &failed)).unwrap();
    for key in ["host", "cpu", "ram", "netUp", "netDown", "uptime", "users", "partitions", "nfs"] {
        assert_eq!(linux[key]["available"], json!(false), "{key}");
    }
    assert_eq!(linux["unavailableReason"], linux["cpu"]["reason"]);
    assert!(linux["unavailableReason"].is_string());

    // One measured metric is a measurement: no flag.
    let mut one = failed.clone();
    one.retain(|s| s.0 != "meminfo");
    let partial = to_value(sample(&mut Reducer::default(), "", &one)).unwrap();
    assert_eq!(partial["ram"]["available"], json!(true));
    assert!(partial.get("unavailableReason").is_none());

    // A named unsupported platform keeps its own status even though Host failed too (D95).
    let bsd = to_value(sample(&mut Reducer::default(), "", &[("platform", "FreeBSD", 0), ("hostname", "", 1)])).unwrap();
    assert_eq!(bsd["unsupportedPlatform"], json!("FreeBSD"));
    assert!(bsd.get("unavailableReason").is_none());
}
