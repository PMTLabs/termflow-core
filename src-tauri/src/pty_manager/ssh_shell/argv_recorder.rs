//! Standalone native executable compiled by the real-shell fixtures, not the app.
//!
//! `TF_ARGV_RECORD`: overwrite that file with this invocation's argv (JSON).
//! `TF_ARGV_LOG`: append one JSON line per invocation, with the bytes of
//! `TF_TRUST_FILE` as they were when this process started (`null` if absent).
//! `TF_ARGV_EXEC`: then run that executable with the same argv and exit with its
//! status (POSIX: `exec`, so the real program keeps this process and its stdio).

use std::{env, fs, io::Write, thread, time::Duration};

fn json(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c <= '\u{1f}' => {
                use std::fmt::Write;
                write!(out, "\\u{:04x}", c as u32).unwrap();
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let argv = format!("[{}]", args.iter().map(|arg| json(arg)).collect::<Vec<_>>().join(","));
    if let Some(record) = env::var_os("TF_ARGV_RECORD") {
        fs::write(record, &argv).unwrap();
        // Keep cmd's $T prompt epochs distinct even on a fast machine.
        thread::sleep(Duration::from_millis(75));
    }
    if let Some(log) = env::var_os("TF_ARGV_LOG") {
        let trust = env::var_os("TF_TRUST_FILE")
            .and_then(|path| fs::read(path).ok())
            .map_or_else(|| "null".to_owned(), |bytes| json(&String::from_utf8_lossy(&bytes)));
        let mut file = fs::OpenOptions::new().create(true).append(true).open(log).unwrap();
        file.write_all(format!("{{\"argv\":{argv},\"trust\":{trust}}}\n").as_bytes()).unwrap();
        file.sync_all().unwrap();
    }
    if let Some(program) = env::var_os("TF_ARGV_EXEC") {
        let mut command = std::process::Command::new(program);
        command.args(&args);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            panic!("exec failed: {}", command.exec());
        }
        #[cfg(not(unix))]
        std::process::exit(command.status().unwrap().code().unwrap_or(1));
    }
}
