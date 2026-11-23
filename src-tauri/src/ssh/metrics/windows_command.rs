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
    let gz = PAYLOAD.trim_end();
    let bootstrap = format!(concat!(
        "&([scriptblock]::Create((New-Object IO.StreamReader((New-Object IO.Compression.GzipStream(",
        "(New-Object IO.MemoryStream(,[Convert]::FromBase64String('{gz}'))),",
        "[IO.Compression.CompressionMode]::Decompress)))).ReadToEnd())) '{nonce}'",
    ), gz = gz, nonce = nonce);
    let utf16: Vec<_> = bootstrap
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    Some(format!("{PREFIX}{}", STANDARD.encode(utf16)))
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
        let (_, nonce) = bootstrap.strip_suffix('\'')?.rsplit_once(" '")?;
        (valid_nonce(nonce)
            && bootstrap.matches(nonce).count() == 1
            && encode(nonce)?.as_str() == command)
            .then(|| nonce.to_owned())
    }

    #[test]
    fn windows_command_is_shell_neutral() {
        let (command, nonce) = windows_collector_command();
        assert!(command.starts_with(PREFIX));
        assert!(command.len() <= 7000, "{} bytes", command.len());
        assert!(command
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/= -".contains(&b)));
        assert_eq!(extract_nonce(&command), Some(nonce));
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
                "{shell}: {}",
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
}
