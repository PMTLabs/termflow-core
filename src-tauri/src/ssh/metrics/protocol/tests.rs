use super::*;

#[test]
fn captured_protocol_accepts_lf_and_crlf_without_altering_values() {
    let lf = linux(&[]);
    let crlf = lf.replace('\n', "\r\n");
    let a = parse(lf.as_bytes(), NONCE).unwrap();
    let b = parse(crlf.as_bytes(), NONCE).unwrap();
    assert_eq!(a.sections, b.sections);
    assert_eq!((a.hostname, a.os, a.local, a.nfs), (b.hostname, b.os, b.local, b.nfs));

    // A CR inside a value is NOT a framing byte; stripping all CRs would turn
    // this malformed value into a plausible hostname.
    let invalid = lf.replace("derived-host", "derived-\rhost").replace('\n', "\r\n");
    assert_eq!(parse(invalid.as_bytes(), NONCE).unwrap().hostname,
        Err("Metrics section contains invalid or oversized fields"));
}

const NONCE: &str = "06900000000000000000000000000001";
const LOCAL: &str = "Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/vda ext4 100 30 60 34% /\n";
const NFS: &str = "Filesystem 1024-blocks Used Available Capacity Mounted on\nserver:/vol 200 36 150 20% /srv/nfs\n";
const MOUNTS: &str = "/dev/vda / ext4 rw 0 0\nserver:/vol /srv/nfs nfs4 rw 0 0\n";
const MEM: &str = "MemTotal: 1000 kB\nMemAvailable: 600 kB\n";
const LOCAL_ROW: (&str, &str, &str, u64, u64, u64, u64) =
    ("/dev/vda", "/", "ext4", 102400, 30720, 61440, 34);
const NFS_ROW: (&str, &str, &str, u64, u64, u64, u64) =
    ("server:/vol", "/srv/nfs", "nfs4", 204800, 36864, 153600, 20);

fn row(m: &MountUsage) -> (&str, &str, &str, u64, u64, u64, u64) {
    (&m.source, &m.mount_point, &m.fs_type, m.total_bytes, m.used_bytes, m.available_bytes, m.used_percent)
}

fn section(key: &str, body: &str, status: u8) -> String {
    format!("__TFM_{NONCE}_SECTION_{key}_BEGIN__\n{body}\n__TFM_{NONCE}_SECTION_{key}_END_{status}__\n")
}

fn linux(changes: &[(&str, &str, u8)]) -> String {
    let mut out = format!("__TFM_{NONCE}_V1_BEGIN__\n");
    for &key in COMMON.iter().chain(LINUX) {
        let (body, exit) = changes.iter().find(|c| c.0 == key).map(|c| (c.1, c.2)).unwrap_or_else(|| {
            (match key {
                "platform" => "Linux",
                "hostname" => "derived-host",
                "architecture" => "x86_64",
                "meminfo" => MEM,
                "mounts" => MOUNTS,
                "dfLocal" => LOCAL,
                "dfNfs" => NFS,
                _ => "",
            }, 0)
        });
        out.push_str(&section(key, body, exit));
    }
    out.push_str(&format!("__TFM_{NONCE}_V1_END__\n"));
    out
}

fn parsed(text: &str) -> RawSample<'_> {
    parse(text.as_bytes(), NONCE).expect("complete envelope")
}

fn capture(label: &str, bytes: &'static str) -> RawSample<'static> {
    assert!(!bytes.starts_with("PENDING CAPTURE"), "{label}: real capture required; see fixtures/README.md");
    let nonce = bytes.lines().find_map(|line| {
        let candidate = line.strip_prefix("__TFM_")?.strip_suffix("_V1_BEGIN__")?;
        valid_nonce(candidate).then_some(candidate)
    }).expect("real capture must contain a production nonce");
    parse(bytes.as_bytes(), nonce).expect("complete capture envelope")
}

// Orchestrator: fill these literal oracles from independently inspected captures,
// never by running this parser to generate expected values.
const UBUNTU_FIELDS: Option<[&str; 7]> = Some([
    "tf-metrics-ubuntu",
    "x86_64",
    "Ubuntu 24.04",
    "cpu  72525712 139 12419141 1658499522 8448405 0 7167439 0 1085468 0",
    "MemTotal:       49327760 kB",
    "732604.51 16584995.26",
    "3.98 3.72 3.35 1/3221 2139206",
]);
const ALPINE_MEM_TOTAL: Option<&str> = Some("MemTotal:       49327760 kB");
// nfs.txt is DERIVED, NOT CAPTURED (leader ruling D55): the real Ubuntu envelope
// with a modeled mount table; see fixtures/README.md.
const NFS_LOCAL_IDENTITIES: &[(&str, &str, &str)] = &[
    ("/dev/sda1", "/", "ext4"),
    ("/dev/sdb1", "/data disk", "xfs"),
];
const NFS_REMOTE_IDENTITIES: &[(&str, &str, &str)] = &[
    ("nas.example:/export/home", "/mnt/home", "nfs4"),
    ("nas.example:/export/old", "/mnt/old", "nfs"),
];

#[test]
fn ubuntu_capture_preserves_all_sections_and_statuses() {
    let s = capture("Ubuntu", include_str!("../fixtures/ubuntu.txt"));
    let expected = UBUNTU_FIELDS.expect("record Ubuntu hostname, architecture, OS, aggregate stat, MemTotal, uptime, and loadavg literals");
    assert_eq!(s.platform, Platform::Linux);
    for &key in COMMON.iter().chain(LINUX) {
        let section = s.section(key).unwrap();
        assert_eq!(section.exit, 0, "{key}");
        assert!(section.rows().is_ok(), "{key}");
    }
    assert_eq!([
        s.hostname.as_deref().unwrap(), s.architecture.as_deref().unwrap(), s.os.as_deref().unwrap(),
        s.section("stat").unwrap().rows().unwrap()[0],
        s.section("meminfo").unwrap().rows().unwrap()[0],
        s.section("uptime").unwrap().rows().unwrap()[0],
        s.section("loadavg").unwrap().rows().unwrap()[0],
    ], expected);
    let local = s.local.unwrap();
    assert!(!local.is_empty());
    assert_eq!(local.iter().map(|m| (m.source.as_str(), m.mount_point.as_str(), m.fs_type.as_str())).collect::<Vec<_>>(),
        [("/dev/sdd", "/", "ext4"), ("/dev/sde", "/srv/runner-data", "ext4")]);
    assert!(s.nfs.unwrap().is_empty());
}

#[test]
fn alpine_capture_without_who_keeps_memory_but_users_unavailable() {
    let s = capture("Alpine", include_str!("../fixtures/alpine.txt"));
    assert_eq!(s.platform, Platform::Linux);
    assert_eq!(s.section("meminfo").unwrap().rows().unwrap()[0], ALPINE_MEM_TOTAL.expect("record Alpine MemTotal literal"));
    let who = s.section("who").unwrap();
    assert_ne!(who.exit, 0);
    assert!(who.rows().is_err());
    let denied = include_str!("../fixtures/derived-who-permission.txt");
    for (status, body) in [(126, denied), (1, "partial-user pts/0\n"), (0, "")] {
        let text = linux(&[("who", body, status)]);
        let s = parsed(&text);
        assert_eq!(s.section("meminfo").unwrap().rows().unwrap(), ["MemTotal: 1000 kB", "MemAvailable: 600 kB"]);
        assert_eq!(s.section("who").unwrap().exit, status);
        match status {
            0 => assert!(s.section("who").unwrap().rows().unwrap().is_empty()),
            _ => assert!(s.section("who").unwrap().rows().is_err()),
        }
    }
}

#[test]
fn nfs_capture_separates_nfs4_and_local_not_tmpfs_or_cifs() {
    let s = capture("NFS", include_str!("../fixtures/nfs.txt"));
    let identity = |rows: &[MountUsage]| rows.iter().map(|m| (m.source.clone(), m.mount_point.clone(), m.fs_type.clone())).collect::<Vec<_>>();
    let expected = |rows: &[(&str, &str, &str)]| rows.iter().map(|&(s, p, t)| (s.to_owned(), p.to_owned(), t.to_owned())).collect::<Vec<_>>();
    assert!(!NFS_LOCAL_IDENTITIES.is_empty() && NFS_REMOTE_IDENTITIES.iter().any(|r| r.2 == "nfs4"), "record exact mount identities");
    assert_eq!(identity(&s.local.unwrap()), expected(NFS_LOCAL_IDENTITIES));
    assert_eq!(identity(&s.nfs.unwrap()), expected(NFS_REMOTE_IDENTITIES));

    let extra = format!("{LOCAL}tmp tmpfs 20 10 10 50% /ram\n//server/share cifs 20 10 10 50% /smb\nremote fuse.sshfs 20 10 10 50% /ssh\nshare 9p 20 10 10 50% /virt\n/dev/data xfs 20 10 10 50% /data\\040with spaces\n");
    let text = linux(&[("dfLocal", &extra, 0)]);
    let s = parsed(&text);
    let local = s.local.unwrap();
    assert_eq!(local.iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW, ("/dev/data", "/data with spaces", "xfs", 20480, 10240, 10240, 50)]);
    assert_eq!(row(&s.nfs.unwrap()[0]), NFS_ROW);
    assert_eq!(fs_kind("exotic", "/"), Fs::Unknown);
    let ambiguous = extra.replace(" tmpfs ", " exotic ");
    assert_eq!(parsed(&linux(&[("dfLocal", &ambiguous, 0)])).local, Err(BAD_TYPE));
}

#[test]
fn freebsd_capture_marks_metrics_unsupported() {
    #[cfg(unix)]
    executable::freebsd_has_no_proc_trace();
    let s = capture("FreeBSD", include_str!("../fixtures/non-linux.txt"));
    assert_freebsd(&s, "tf-metrics-freebsd", "arm64");
}

fn assert_freebsd(s: &RawSample<'_>, hostname: &str, architecture: &str) {
    assert_eq!(s.platform, Platform::Unsupported("FreeBSD".into()));
    assert_eq!(s.platform.unavailable_reason().as_deref(), Some("Metrics are supported only on Linux and macOS (FreeBSD)"));
    assert_eq!(s.platform.unsupported_label().as_deref(), Some("FreeBSD"));
    // T1 is raw: one platform gate supplies the same reason for the eight Linux
    // metrics; all Linux dependencies must be absent rather than zero-filled.
    // uname -n/-m run everywhere (D95: Host shows the measured hostname).
    assert_eq!(s.hostname, Ok(hostname.into()));
    assert_eq!(s.architecture, Ok(architecture.into()));
    assert_eq!(s.os, Ok("FreeBSD".into()));
    for key in LINUX {
        assert!(s.section(key).is_none(), "unexpected Linux section {key}");
    }
    assert!(s.local.is_err() && s.nfs.is_err());
}

#[test]
fn framing_rejects_duplicate_missing_and_wrong_nonce_sections() {
    let good = linux(&[]);
    let stat = section("stat", "", 0);
    for bad in [
        good.replace(stat.as_str(), &format!("{stat}{stat}")),
        good.replace(stat.as_str(), ""),
        good.replace(stat.as_str(), &stat.replace(NONCE, "ffffffffffffffffffffffffffffffff")),
        good.replace(stat.as_str(), &stat.replace("stat", "unexpected")),
        good.replace(stat.as_str(), &stat.replacen("\n\n", "", 1)),
        good.trim_end().to_owned(),
        good.replace(format!("__TFM_{NONCE}_V1_END__\n").as_str(), ""),
        format!("{good}{good}"),
        good.replace(stat.as_str(), include_str!("../fixtures/derived-malformed.txt")),
    ] {
        assert!(parse(bad.as_bytes(), NONCE).is_err(), "accepted malformed envelope");
    }
    assert!(parse(good.as_bytes(), "bad nonce").is_err());
    assert!(parse([good.as_bytes(), b"\xff"].concat().as_slice(), NONCE).is_err());
    assert!(parse([good.as_bytes(), b"\0"].concat().as_slice(), NONCE).is_err());
    let noisy = format!("login banner\n{good}logout banner without newline");
    assert_eq!(parsed(&noisy).platform, Platform::Linux);
    assert_eq!(parsed(&good.replace('\n', "\r\n")).local, parsed(&good).local);
}

#[test]
fn nonzero_df_stdout_is_not_success() {
    for (local, nfs) in [(1, 0), (0, 1), (1, 1), (0, 0)] {
        let text = linux(&[("dfLocal", LOCAL, local), ("dfNfs", NFS, nfs)]);
        let s = parsed(&text);
        assert_eq!(s.section("dfLocal").unwrap().exit, local);
        assert_eq!(s.section("dfNfs").unwrap().exit, nfs);
        assert_eq!(s.local.as_ref().ok().map(|m| row(&m[0])), (local == 0).then_some(LOCAL_ROW));
        assert_eq!(s.nfs.as_ref().ok().map(|m| row(&m[0])), (nfs == 0).then_some(NFS_ROW));
    }
    let header = LOCAL.lines().next().unwrap();
    let empty = linux(&[("dfLocal", header, 0), ("dfNfs", "", 0), ("mounts", "", 0)]);
    assert!(parsed(&empty).local.unwrap().is_empty());
    assert!(parsed(&empty).nfs.unwrap().is_empty());
    assert!(parsed(&linux(&[("dfNfs", "", 0)])).nfs.is_err());
}

#[test]
fn confirmed_local_df_survives_returning_failed_nfs_df() {
    let failed = linux(&[("dfNfs", NFS, 1)]);
    let s = parsed(&failed);
    assert_eq!(s.local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW]);
    assert!(s.nfs.is_err());
    assert!(!s.nfs_watchdog_expired);
    assert_eq!(parsed(&linux(&[])).nfs.unwrap().iter().map(row).collect::<Vec<_>>(), [NFS_ROW]);
}

#[test]
fn ambiguous_mount_type_never_claimed_local() {
    let fallback = "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/vda\n   100 30 60 34% /\n";
    for inventory in ["", "/dev/vda / mystery rw 0 0\n", "/dev/vda / ext4 rw 0 0\n/dev/vda / cifs rw 0 0\n"] {
        assert_eq!(parsed(&linux(&[("dfLocal", fallback, 0), ("mounts", inventory, 0)])).local, Err(BAD_TYPE));
    }
    let stacked = "/dev/vda / ext4 rw 0 0\n/dev/vda / ext4 rw 0 0\n";
    assert_eq!(parsed(&linux(&[("dfLocal", fallback, 0), ("mounts", stacked, 0)]))
        .local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW]);
    let recovered = linux(&[("dfLocal", fallback, 0)]);
    let s = parsed(&recovered);
    assert_eq!(s.local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW]);
    assert_eq!(s.nfs.unwrap().iter().map(row).collect::<Vec<_>>(), [NFS_ROW]);
}

#[test]
fn collector_local_type_census_matches_parser() {
    let list = include_str!("../collect.sh").lines()
        .find_map(|line| line.trim().strip_prefix("local_types='")?.strip_suffix('\''))
        .expect("collector local type list");
    assert_eq!(list.split_ascii_whitespace().collect::<Vec<_>>(), LOCAL_TYPES);
    assert!(LOCAL_TYPES.iter().all(|ty| fs_kind(ty, "/") == Fs::Local));
}

#[test]
fn real_host_filesystem_policy() {
    for (ty, point, expected) in [
        ("overlay", "/", Ok(1)), ("overlay", "/other", Ok(0)),
        ("rootfs", "/", Ok(0)), ("fuse", "/", Ok(0)),
        ("fuse.anything", "/", Ok(0)), ("fuse.sshfs", "/", Ok(0)),
        ("fuseblk", "/", Ok(1)), ("squashfs", "/", Ok(0)),
        ("erofs", "/", Ok(0)), ("iso9660", "/", Ok(0)),
        ("mystery", "/", Err(BAD_TYPE)),
    ] {
        let body = format!("Filesystem Type 1K-blocks Used Available Use% Mounted on\ndisk {ty} 100 30 60 34% {point}\n");
        assert_eq!(parsed(&linux(&[("dfLocal", &body, 0)])).local.map(|rows| rows.len()), expected, "{ty} {point}");
    }
}

#[test]
fn raw_bounds_and_df_overflow_fail_independently() {
    for oversized in ["x".repeat(FIELD_LIMIT + 1), "x\n".repeat(ROW_LIMIT + 1), "in\rterior".into()] {
        let text = linux(&[("meminfo", &oversized, 0)]);
        let s = parsed(&text);
        assert_eq!(s.section("meminfo").unwrap().exit, 0);
        assert!(s.section("meminfo").unwrap().rows().is_err());
        assert_eq!(s.local.unwrap().iter().map(row).collect::<Vec<_>>(), [LOCAL_ROW]);
    }
    for number in ["18014398509481984", "18446744073709551616"] {
        let overflow = LOCAL.replace(" 100 ", &format!(" {number} "));
        let text = linux(&[("dfLocal", &overflow, 0)]);
        let s = parsed(&text);
        assert_eq!(s.local, Err(BAD_DF));
        assert_eq!(s.nfs.unwrap().iter().map(row).collect::<Vec<_>>(), [NFS_ROW]);
    }
    let mut max = "x\n".repeat(ROW_LIMIT - 1);
    max.push_str(&"x".repeat(FIELD_LIMIT));
    let text = linux(&[("meminfo", &max, 0)]);
    assert_eq!(parsed(&text).section("meminfo").unwrap().rows().unwrap().len(), ROW_LIMIT);
    assert!(parse(&vec![b'x'; CAP + 1], NONCE).is_err());
}

#[cfg(unix)]
mod executable;
