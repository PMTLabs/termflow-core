//! Fixed, inspectable PowerShell payload; only the generated frame nonce varies.
use super::protocol::valid_nonce;
use base64::{engine::general_purpose::STANDARD, Engine as _};

const PREFIX: &str = "powershell -NoProfile -NonInteractive -EncodedCommand ";
const PAYLOAD: &str = include_str!("collect.ps1.gz.b64");

pub(super) fn windows_collector_command() -> (String, String) {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let command = encode(&nonce).expect("UUID generated as lowercase hex");
    (command, nonce)
}

fn encode(nonce: &str) -> Option<String> {
    if !valid_nonce(nonce) {
        return None;
    }
    Some(encode_bootstrap(&bootstrap(nonce)?))
}

fn bootstrap(nonce: &str) -> Option<String> {
    let gz = STANDARD.decode(PAYLOAD.trim_end()).ok()?;
    // The last code unit can carry padding that unpacks as one extra zero byte;
    // trim to the exact length so a strict gzip reader never sees trailing data.
    let gz_len = gz.len();
    // The outer command must fit cmd.exe. Pack 15 gzip bits per UTF-16
    // code unit in a range with no surrogates, quotes or line terminators.
    let mut packed = String::new();
    let (mut word, mut bits) = (0u32, 0);
    for byte in gz {
        word |= u32::from(byte) << bits;
        bits += 8;
        if bits >= 15 {
            packed.push(char::from_u32(0x4000 + (word & 0x7fff))?);
            word >>= 15;
            bits -= 15;
        }
    }
    if bits != 0 {
        packed.push(char::from_u32(0x4000 + word)?);
    }
    let clm = include_str!("collect-clm.ps1");
    Some(format!(concat!(
        "$n='{nonce}';$s=$null\n",
        "if($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage'){{try{{",
        "$m=[IO.MemoryStream]::new();$w=$b=0;",
        "foreach($c in '{packed}'.ToCharArray()){{$w=$w -bor (([int]$c-0x4000) -shl $b);$b+=15;",
        "while($b -ge 8){{$m.WriteByte($w -band 255);$w=$w -shr 8;$b-=8}}}};",
        "$m.SetLength({gz_len});$m.Position=0;$z=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);",
        "$s=[scriptblock]::Create([IO.StreamReader]::new($z).ReadToEnd())",
        "}}catch{{}}}}\nif($s){{&$s $n}}else{{\n{clm}\n}}",
    ), nonce = nonce, packed = packed, gz_len = gz_len, clm = clm))
}

fn encode_bootstrap(bootstrap: &str) -> String {
    let utf16: Vec<_> = bootstrap
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    format!("{PREFIX}{}", STANDARD.encode(utf16))
}

#[cfg(test)]
pub(super) use tests::extract_nonce;

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{read::GzDecoder, write::GzEncoder, Compression};
    use std::io::{Read, Write};

    pub(in crate::ssh::metrics) fn extract_nonce(command: &str) -> Option<String> {
        let bytes = STANDARD.decode(command.strip_prefix(PREFIX)?).ok()?;
        if bytes.len() % 2 != 0 {
            return None;
        }
        let units: Vec<_> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let bootstrap = String::from_utf16(&units).ok()?;
        let (nonce, _) = bootstrap.strip_prefix("$n='")?.split_once('\'')?;
        (valid_nonce(nonce)
            && bootstrap.matches(nonce).count() == 1
            && encode(nonce)?.as_str() == command)
            .then(|| nonce.to_owned())
    }

    #[test]
    fn windows_command_is_shell_neutral() {
        let (command, nonce) = windows_collector_command();
        assert!(command.starts_with(PREFIX));
        // cmd.exe caps a command line at 8,191 characters; keep headroom for DefaultShell=cmd.
        assert!(command.len() <= 7500, "{} bytes", command.len());
        assert!(command
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/= -".contains(&b)));
        assert_eq!(extract_nonce(&command), Some(nonce));
    }

    #[test]
    fn windows_collector_does_not_use_wmi_or_compile_code() {
        for source in [include_str!("collect.ps1"), include_str!("collect-clm.ps1")] {
            let source = source.to_ascii_lowercase();
            for forbidden in ["management", "wmi", "cim", "get-counter", "add-type"] {
                assert!(!source.contains(forbidden), "{forbidden}");
            }
        }
    }

    #[test]
    fn windows_payload_inflates_to_collect_ps1() {
        let bytes = STANDARD.decode(PAYLOAD.trim_end()).unwrap();
        let mut body = Vec::new();
        GzDecoder::new(&bytes[..]).read_to_end(&mut body).unwrap();
        assert_eq!(body, include_bytes!("collect.ps1"));
    }

    #[test]
    #[ignore = "prints a regenerated payload; use --nocapture to copy it into collect.ps1.gz.b64"]
    fn regenerate_windows_payload() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(include_bytes!("collect.ps1")).unwrap();
        println!("{}", STANDARD.encode(encoder.finish().unwrap()));
        windows_payload_inflates_to_collect_ps1();
    }

    #[cfg(windows)]
    #[test]
    fn production_windows_command_degrades_under_constrained_language() {
        use crate::ssh::metrics::{
            model::{Host, Metric},
            protocol::{parse, windows, Platform},
            reduce::Reducer,
        };
        use std::process::{Command, Stdio};

        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        let nonce = "0123456789abcdef0123456789abcdef";
        // Retail Windows PowerShell may ignore the test-only lockdown variable.
        // Set the mode explicitly if needed, without modifying the production bootstrap.
        let command = encode_bootstrap(&format!(
            concat!(
                "if($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage')",
                "{{$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'}}\n{}",
            ),
            bootstrap(nonce).unwrap()
        ));
        let output = Command::new("powershell.exe")
            .args(
                command
                    .strip_prefix("powershell ")
                    .unwrap()
                    .split_ascii_whitespace(),
            )
            .env("__PSLockdownPolicy", "4")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{:?}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_ascii() && !output.stdout.contains(&b'\r'));
        assert!(output.stdout.ends_with(b"V1_END__\n"));
        assert!(output.stderr.len() < 16 * 1024);
        let raw = parse(&output.stdout, nonce).unwrap();
        assert_eq!(raw.platform, Platform::Windows);
        assert!(raw.hostname.is_ok() && raw.architecture.is_ok() && raw.os.is_ok());
        for key in ["winOs", "winCpu", "winNet", "winDisks", "winNetDrives"] {
            assert!(windows::blocked(raw.section(key).unwrap()), "{key}");
        }
        let metrics = Reducer::default().reduce(raw);
        assert!(matches!(metrics.host, Metric::Available(Host {
            os: Metric::Available(_),
            architecture: Metric::Available(_),
            ..
        })));
        let blocked = || Metric::Unavailable(windows::BLOCKED.into());
        assert_eq!(metrics.cpu, blocked());
        assert_eq!(metrics.ram, Metric::Unavailable(windows::BLOCKED.into()));
        assert_eq!(metrics.uptime, Metric::Unavailable(windows::BLOCKED.into()));
        assert_eq!(metrics.net_up, Metric::Unavailable(windows::BLOCKED.into()));
        assert_eq!(metrics.net_down, Metric::Unavailable(windows::BLOCKED.into()));
        assert_eq!(
            metrics.partitions,
            Metric::Unavailable(windows::BLOCKED.into())
        );
        assert_eq!(metrics.nfs, Metric::Unavailable(windows::BLOCKED.into()));
    }

    #[cfg(windows)]
    #[test]
    fn production_windows_command_runs_under_supported_shells() {
        use crate::ssh::metrics::protocol::{parse, Platform, WINDOWS};
        use std::{
            io::ErrorKind,
            os::windows::process::CommandExt,
            process::{Command, Stdio},
        };

        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        for shell in ["cmd.exe", "powershell.exe", "pwsh.exe"] {
            let (command, nonce) = windows_collector_command();
            let mut child = Command::new(shell);
            child.stdin(Stdio::null());
            let result = if shell == "cmd.exe" {
                child.args(["/d", "/c"]).raw_arg(&command).output()
            } else {
                child
                    .args(["-NoProfile", "-NonInteractive", "-c", &command])
                    .output()
            };
            let output = match result {
                Err(error) if error.kind() == ErrorKind::NotFound && shell == "pwsh.exe" => {
                    continue
                }
                result => result.unwrap_or_else(|error| panic!("{shell}: {error}")),
            };
            assert!(
                output.status.success(),
                "{shell} {:?}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
            let raw =
                parse(&output.stdout, &nonce).unwrap_or_else(|reason| panic!("{shell}: {reason}"));
            assert_eq!(raw.platform, Platform::Windows);
            for key in ["platform", "hostname", "architecture"]
                .iter()
                .chain(WINDOWS)
            {
                if *key != "winUsers" {
                    assert_eq!(raw.section(key).unwrap().exit, 0, "{shell}: {key}");
                }
            }
        }
    }
    #[cfg(windows)]
    #[test]
    fn registry_failure_keeps_clock_ram_and_cpu_in_production_payload() {
        use crate::ssh::metrics::{
            model::{Host, Metric},
            protocol::{parse, Platform},
            reduce::Reducer,
        };
        use std::process::{Command, Stdio};

        let _gate = crate::pty_host_client::test_dirs::child_process_gate();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        // Shadow the registry read the winOs section makes; the payload's scriptblock sees
        // this function before the cmdlet, so the read throws under ErrorActionPreference=Stop.
        let script = format!(
            "function Get-ItemProperty {{ throw 'registry unavailable' }}
{}",
            bootstrap(&nonce).unwrap()
        );
        let command = encode_bootstrap(&script);
        let encoded = command.strip_prefix(PREFIX).unwrap();
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let raw = parse(&output.stdout, &nonce).unwrap();
        assert_eq!(raw.platform, Platform::Windows);
        assert_eq!(raw.section("winOs").unwrap().exit, 0);
        let metrics = Reducer::default().reduce(raw);
        assert!(matches!(metrics.uptime, Metric::Available(_)), "{:?}", metrics.uptime);
        assert!(matches!(metrics.ram, Metric::Available(_)), "{:?}", metrics.ram);
        assert!(matches!(metrics.cpu, Metric::Available(_)), "{:?}", metrics.cpu);
        let Metric::Available(Host { os, .. }) = metrics.host else {
            panic!("{:?}", metrics.host)
        };
        assert_eq!(os, Metric::Unavailable("Invalid Windows metrics fields".into()));
    }
}
