//! Standalone native executable compiled by the real-shell fixtures, not the app.

use std::{env, fs, thread, time::Duration};

fn main() {
    let argv = env::args().skip(1).map(|arg| {
        let mut out = String::from("\"");
        for ch in arg.chars() {
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
    }).collect::<Vec<_>>();
    fs::write(env::var_os("TF_ARGV_RECORD").unwrap(), format!("[{}]", argv.join(","))).unwrap();
    // Keep cmd's $T prompt epochs distinct even on a fast machine.
    thread::sleep(Duration::from_millis(75));
}
