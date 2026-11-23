use super::*;
use crate::ssh::metrics::protocol::{parse, Platform, WINDOWS};

const NONCE: &str = "0123456789abcdef0123456789abcdef";
const CAPTURE: &str = include_str!("../../fixtures/windows.txt");

fn parse_capture(text: &str) -> RawSample<'_> {
    parse(text.as_bytes(), NONCE).unwrap()
}

#[test]
fn windows_capture_parses_every_section_with_exact_values() {
    let sample = parse_capture(CAPTURE);
    assert_eq!(sample.platform, Platform::Windows);
    assert_eq!(sample.hostname.as_deref(), Ok("WINHOST"));
    assert_eq!(sample.architecture.as_deref(), Ok("AMD64"));
    assert_eq!(sample.os.as_deref(), Ok("Windows 11 Pro 10.0.26300.9974"));
    for key in ["platform", "hostname", "architecture"]
        .iter()
        .chain(WINDOWS)
    {
        assert_eq!(sample.section(key).unwrap().exit, 0, "{key}");
    }
    let os = fields(sample.section("winOs").unwrap().rows()).unwrap();
    assert_eq!(number::<u64>(&os, "uptimeTicks"), Ok(10_714_475_851_337));
    assert_eq!(number::<u64>(&os, "tickFrequency"), Ok(10_000_000));
    assert_eq!(number::<u64>(&os, "totalBytes"), Ok(136_770_584_576));
    assert_eq!(number::<u64>(&os, "availBytes"), Ok(43_341_094_912));
    let cpu = fields(sample.section("winCpu").unwrap().rows()).unwrap();
    assert_eq!(number::<u64>(&cpu, "idle100ns"), Ok(147_657_066_562_500));
    assert_eq!(number::<u64>(&cpu, "kernel100ns"), Ok(182_201_060_625_000));
    assert_eq!(number::<u64>(&cpu, "user100ns"), Ok(27_725_021_250_000));
    assert_eq!(number::<u32>(&cpu, "cores"), Ok(24));
    let net = perf_rows(sample.section("winNet").unwrap().rows()).unwrap();
    assert_eq!(net.len(), 9);
    assert_eq!(net["Ethernet 3 2"], [119_227_901, 126_461_123]);
    assert_eq!(net["Wi-Fi 3"], [17_672_398_312, 11_787_356_980]);
    assert_eq!(net["Ethernet 6"], [74_417_090_392, 335_468_873_934]);
    assert_eq!(net["Wi-Fi 1 2"], [0, 0]);
    assert_eq!(
        users(sample.section("winUsers").unwrap().rows()),
        Ok(Users {
            count: 1,
            names: vec!["user1".into()]
        })
    );
    let disks = sample.local.unwrap();
    assert_eq!(
        disks
            .iter()
            .map(|disk| (
                disk.source.as_str(),
                disk.fs_type.as_str(),
                disk.total_bytes,
                disk.available_bytes
            ))
            .collect::<Vec<_>>(),
        [
            ("C:", "NTFS", 858993455104, 32842526720),
            ("D:", "NTFS", 1140380921856, 38993510400),
            ("E:", "NTFS", 462315057152, 96611622912),
            ("F:", "ReFS", 536803803136, 143502266368),
        ]
    );
    let [drive] = sample.nfs.unwrap().try_into().unwrap();
    assert_eq!(
        drive,
        MountUsage {
            source: r"\\nas.example\share".into(),
            mount_point: "M:".into(),
            fs_type: String::new(),
            total_bytes: 494384795648,
            available_bytes: 42860441600,
            used_bytes: 451524354048,
            used_percent: 92
        }
    );
}

#[test]
fn windows_crlf_capture_parses_identically() {
    let crlf = include_str!("../../fixtures/windows-crlf.txt");
    assert!(crlf.contains("\r\n"));
    let (lf, crlf) = (parse_capture(CAPTURE), parse_capture(crlf));
    assert_eq!(lf.platform, crlf.platform);
    assert_eq!(lf.local, crlf.local);
    assert_eq!(lf.nfs, crlf.nfs);
    assert_eq!(lf.sections, crlf.sections);
}

#[test]
fn windows_linux_darwin_sections_are_mutually_exclusive() {
    for platform in ["Linux", "Darwin"] {
        assert!(parse(
            CAPTURE
                .replace("\nWindows\n", &format!("\n{platform}\n"))
                .as_bytes(),
            NONCE
        )
        .is_err());
    }
    let end = format!("__TFM_{NONCE}_V1_END__\n");
    for key in ["stat", "swVers"] {
        let extra =
            format!("__TFM_{NONCE}_SECTION_{key}_BEGIN__\n__TFM_{NONCE}_SECTION_{key}_END_0__\n");
        assert!(parse(
            CAPTURE.replace(&end, &format!("{extra}{end}")).as_bytes(),
            NONCE
        )
        .is_err());
    }
}

#[test]
fn escaped_non_ascii_round_trips_and_raw_non_ascii_is_rejected() {
    let escaped = include_str!("../../fixtures/windows-escaped-host.txt");
    assert_eq!(parse_capture(escaped).hostname.as_deref(), Ok("WINé🚀"));
    for (from, to) in [
        (r"WIN\u00e9\ud83d\ude80", "WINé🚀"),
        ("Ethernet 1", "Réseau 1"),
    ] {
        assert!(parse(escaped.replace(from, to).as_bytes(), NONCE).is_err());
    }
    assert_eq!(unescape(r"a\u005cb\u0009"), Ok("a\\b\t".into()));
    for bad in [r"\n", r"\u00", r"\uzzzz", r"\ud800"] {
        assert!(unescape(bad).is_err());
    }
    assert!(unescape(&"x".repeat(FIELD_LIMIT + 1)).is_err());
}

#[test]
fn perf_rows_keep_names_with_spaces_and_brackets() {
    let net = perf_rows(Ok(&[r"1 2 Wi-Fi [Test] _2", r"4 5 R\u00e9seau"])).unwrap();
    assert_eq!(net["Wi-Fi [Test] _2"], [1, 2]);
    assert_eq!(net["Réseau"], [4, 5]);
    assert!(perf_rows(Ok(&["1 2 x", "1 2 x"])).is_err());
    assert!(perf_rows(Ok(&["18446744073709551616 1 x"])).is_err());
}

#[test]
fn quser_header_is_skipped_by_position_and_current_marker_stripped() {
    assert_eq!(
        users(Ok(&[
            r"NOM D\u2019UTILISATEUR",
            " >alice RDP",
            "bob console",
            ">alice console"
        ])),
        Ok(Users {
            count: 3,
            names: vec!["alice".into(), "bob".into()]
        })
    );
    let raw = parse_capture(include_str!("../../fixtures/windows-no-quser.txt"));
    assert_eq!(
        users(raw.section("winUsers").unwrap().rows()),
        Err("Required utility unavailable")
    );
}

#[test]
fn windows_locked_down_frame_keeps_registry_metadata() {
    let text = include_str!("../../fixtures/windows-clm.txt");
    assert!(text.is_ascii() && !text.contains('\r'));
    let raw = parse_capture(text);
    assert_eq!(raw.hostname.as_deref(), Ok("WINHOST"));
    assert_eq!(raw.os.as_deref(), Ok("Windows 11 Pro 10.0.26300.9974"));
    assert_eq!(raw.local, Err(BLOCKED));
    assert_eq!(raw.nfs, Err(BLOCKED));
    for key in ["winOs", "winCpu", "winNet", "winDisks", "winNetDrives"] {
        assert!(blocked(raw.section(key).unwrap()), "{key}");
    }
}

#[test]
fn windows_empty_drive_has_no_partition_and_watchdog_is_not_a_mount() {
    let empty = parse_capture(include_str!("../../fixtures/windows-empty-drive.txt"));
    assert_eq!(empty.local, parse_capture(CAPTURE).local);
    let timeout = parse_capture(include_str!("../../fixtures/windows-watchdog.txt"));
    assert!(timeout.nfs_watchdog_expired);
    assert_eq!(timeout.nfs, Err(WATCHDOG));
}
