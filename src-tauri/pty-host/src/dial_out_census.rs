//! Plan 055 T8 (I2), the elevated dial-out host: it returns from `main` before the discovery record
//! is built or written, and nothing it runs publishes one, so no connection to it can learn the
//! MCP-hold bit (`CAP_MCP_HOLD` is only ever advertised through that record).
//!
//! The census reads the real text of `main.rs` and `transport/dial.rs` (comments and literals
//! masked, so a mention in prose proves nothing). Each negative case edits the real text and must
//! fail. This crate cannot reuse the app's census machinery, so a small scanner lives here.

const MAIN_RS: &str = include_str!("main.rs");
const DIAL_RS: &str = include_str!("transport/dial.rs");

/// What publishing the record involves; none of it may be reachable from the dial-out branch.
const PUBLISHERS: [&str; 5] = ["write_record(", "TERMFLOW_PTY_RECORD", "HostRecord {", "host_capabilities(", "transport::serve("];
/// What the dial-out host's own code must never name.
const FORBIDDEN_IN_DIAL: [&str; 5] = ["write_record", "heal_record", "HostRecord", "TERMFLOW_PTY_RECORD", "host_capabilities"];

/// `source` with comments and char literals replaced by spaces, and string literals (raw ones too)
/// when `blank_strings` is set. Offsets and newlines are kept. Strings are always traversed, so a
/// `//` inside one is not taken for a comment.
fn mask(source: &str, blank_strings: bool) -> String {
    let b = source.as_bytes();
    let mut out = b.to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in &mut out[from..to] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => {
                let end = source[i..].find('\n').map_or(b.len(), |n| i + n);
                blank(&mut out, i, end);
                i = end;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let (mut depth, mut j) = (1, i + 2);
                while j < b.len() && depth > 0 {
                    if b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                        depth += 1;
                        j += 2;
                    } else if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                        depth -= 1;
                        j += 2;
                    } else {
                        j += 1;
                    }
                }
                blank(&mut out, i, j);
                i = j;
            }
            b'r' if (i == 0 || !ident(b[i - 1])) && matches!(b.get(i + 1), Some(b'"') | Some(b'#')) => {
                let hashes = b[i + 1..].iter().take_while(|&&c| c == b'#').count();
                if b.get(i + 1 + hashes) == Some(&b'"') {
                    let closer = format!("\"{}", "#".repeat(hashes));
                    let from = i + 2 + hashes;
                    let end = source[from..].find(&closer).map_or(b.len(), |n| from + n + closer.len());
                    if blank_strings {
                        blank(&mut out, i, end);
                    }
                    i = end;
                } else {
                    i += 1;
                }
            }
            b'"' => {
                let mut j = i + 1;
                while j < b.len() && b[j] != b'"' {
                    j += if b[j] == b'\\' { 2 } else { 1 };
                }
                let end = (j + 1).min(b.len());
                if blank_strings {
                    blank(&mut out, i, end);
                }
                i = end;
            }
            b'\'' => {
                // A char literal (`'x'`, `'\n'`, `'\u{..}'`), not a lifetime (`'a`).
                let end = if b.get(i + 1) == Some(&b'\\') {
                    source[i + 2..].find('\'').map(|n| i + 2 + n + 1)
                } else {
                    source[i + 1..].chars().next().and_then(|c| (b.get(i + 1 + c.len_utf8()) == Some(&b'\'')).then(|| i + 1 + c.len_utf8() + 1))
                };
                match end {
                    Some(end) => {
                        blank(&mut out, i, end);
                        i = end;
                    }
                    None => i += 1,
                }
            }
            _ => i += 1,
        }
    }
    String::from_utf8(out).expect("masking only writes ASCII spaces")
}

/// Index of the `}` matching the `{` at `open`.
fn matching(m: &str, open: usize) -> usize {
    let mut depth = 0;
    for (i, c) in m.bytes().enumerate().skip(open) {
        match c {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces at {open}");
}

/// Brace nesting of `at` relative to the block opened at `open` (0: a direct statement of it).
fn depth_in(m: &str, open: usize, at: usize) -> i32 {
    m[open + 1..at].bytes().fold(0, |d, c| d + i32::from(c == b'{') - i32::from(c == b'}'))
}

fn occurrences(m: &str, needle: &str) -> Vec<usize> {
    m.match_indices(needle).map(|(at, _)| at).collect()
}

fn norm(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The `{ .. }` span of the function whose header starts with `header` (once in the file).
fn function(m: &str, header: &str) -> Result<(usize, usize), String> {
    let hits = occurrences(m, header);
    if hits.len() != 1 {
        return Err(format!("`{header}` must occur exactly once, found {}", hits.len()));
    }
    let open = hits[0] + m[hits[0]..].find('{').ok_or("no body")?;
    Ok((open, matching(m, open)))
}

fn check(main_rs: &str, dial_rs: &str) -> Result<(), String> {
    let main_rs = main_rs.replace("\r\n", "\n");
    let m = mask(&main_rs, true);
    // Same offsets, string contents kept: the environment variable names are string literals.
    let k = mask(&main_rs, false);
    let (open, close) = function(&m, "async fn main()")?;

    // 1. The dial-out branch: a top-level `if let` on `parse_dial_args()`, no `else`, that runs the
    //    mode and then returns, unconditionally.
    let calls: Vec<usize> = occurrences(&m[open..close], "parse_dial_args()").into_iter().map(|at| open + at).collect();
    if calls.len() != 1 {
        return Err(format!("`main` must call `parse_dial_args()` exactly once, found {}", calls.len()));
    }
    let call = calls[0];
    if depth_in(&m, open, call) != 0 {
        return Err("the dial-out check is not a top-level statement of `main`".into());
    }
    let head_start = m[..call].rfind([';', '{', '}']).map_or(0, |p| p + 1);
    let block_open = call + m[call..].find('{').ok_or("the dial-out branch has no block")?;
    let head = norm(&m[head_start..block_open]);
    if head != "ifletSome(dial_args)=parse_dial_args()" {
        return Err(format!("the dial-out check is `{head}`, not `if let Some(dial_args) = parse_dial_args()`"));
    }
    let block_close = matching(&m, block_open);
    if m[block_close + 1..].trim_start().starts_with("else") {
        return Err("the dial-out branch has an `else`".into());
    }
    let run = occurrences(&m[block_open..block_close], "run_dial_out_mode(dial_args).await;")
        .into_iter()
        .map(|at| block_open + at)
        .find(|&at| depth_in(&m, block_open, at) == 0)
        .ok_or("the dial-out branch does not run the mode unconditionally")?;
    let ret = occurrences(&m[block_open..block_close], "return;")
        .into_iter()
        .map(|at| block_open + at)
        .find(|&at| depth_in(&m, block_open, at) == 0)
        .ok_or("the dial-out branch does not return unconditionally")?;
    if ret < run {
        return Err("the dial-out branch returns before it runs the mode".into());
    }

    // 2. Everything that publishes the record comes after the branch (and exists: the census must
    //    not pass because the markers were renamed away).
    for marker in PUBLISHERS {
        let hits = occurrences(&k[open..close], marker);
        if hits.is_empty() {
            return Err(format!("`{marker}` is gone from `main`; the census would be vacuous"));
        }
        if hits.iter().any(|&at| open + at < block_close) {
            return Err(format!("`{marker}` is reached before the dial-out branch has returned"));
        }
    }

    // 3. The mode itself, in both cfg variants, and the dial transport never publish.
    for header in ["async fn run_dial_out_mode(args: DialArgs)", "async fn run_dial_out_mode(_args: DialArgs)"] {
        let (o, c) = function(&m, header)?;
        for word in FORBIDDEN_IN_DIAL {
            if k[o..c].contains(word) {
                return Err(format!("`run_dial_out_mode` names `{word}`"));
            }
        }
    }
    let dial = mask(&dial_rs.replace("\r\n", "\n"), false);
    for word in FORBIDDEN_IN_DIAL {
        if dial.contains(word) {
            return Err(format!("transport/dial.rs names `{word}`"));
        }
    }
    if !dial.contains("pub async fn serve_dial") {
        return Err("transport/dial.rs no longer defines `serve_dial`; the census is stale".into());
    }
    Ok(())
}

fn mutate(source: &str, from: &str, to: &str) -> String {
    let source = source.replace("\r\n", "\n");
    assert!(source.contains(from), "the mutation target is gone: {from}");
    source.replacen(from, to, 1)
}

/// The real dial-out branch, from `if let` to its closing brace.
fn dial_branch(source: &str) -> String {
    let source = source.replace("\r\n", "\n");
    let start = source.find("    if let Some(dial_args) = parse_dial_args() {").expect("the dial-out branch");
    let end = source[start..].find("        return;\n    }\n").expect("its end") + start + "        return;\n    }\n".len();
    source[start..end].to_string()
}

#[test]
fn the_dial_out_branch_returns_before_the_record_is_published() {
    check(MAIN_RS, DIAL_RS).unwrap();
}

#[test]
fn the_dial_out_census_kills_each_planted_mutation() {
    let branch = dial_branch(MAIN_RS);
    let without = mutate(MAIN_RS, &branch, "");
    let publish_at = "    if let Err(e) = transport::serve(endpoint, token, survivable, record.clone()).await {";
    let main_cases: Vec<(&str, String)> = vec![
        ("the return removed", mutate(MAIN_RS, "        log::logger().flush();\n        return;\n    }\n", "        log::logger().flush();\n    }\n")),
        ("the return only in a comment", mutate(MAIN_RS, "        return;\n    }\n\n    // If we cannot outlive", "        // return;\n    }\n\n    // If we cannot outlive")),
        ("the return under a condition", mutate(MAIN_RS, "        return;\n    }\n\n    // If we cannot outlive", "        if cfg!(debug_assertions) { return; }\n    }\n\n    // If we cannot outlive")),
        ("the return before the mode runs", mutate(MAIN_RS, "        run_dial_out_mode(dial_args).await;\n        log::logger().flush();\n        return;", "        return;\n        run_dial_out_mode(dial_args).await;")),
        ("an else branch", mutate(MAIN_RS, "        return;\n    }\n\n    // If we cannot outlive", "        return;\n    } else {\n        log::info!(\"serving\");\n    }\n\n    // If we cannot outlive")),
        ("the branch moved after the record is published", mutate(&without, publish_at, &format!("{branch}{publish_at}"))),
        ("the branch moved after the capabilities are computed", mutate(&without, "    let survivable = match detach::assert_survivable() {", &format!("    let _caps = host_capabilities(false);\n{branch}    let survivable = match detach::assert_survivable() {{"))),
        ("the capabilities computed before the branch", mutate(MAIN_RS, "    if let Some(dial_args) = parse_dial_args() {", "    let _caps = host_capabilities(false);\n    if let Some(dial_args) = parse_dial_args() {")),
        ("the record written inside the branch", mutate(MAIN_RS, "        run_dial_out_mode(dial_args).await;\n", "        run_dial_out_mode(dial_args).await;\n        let _ = termflow_pty_protocol::write_record(&std::path::PathBuf::new(), &rec);\n")),
        ("the branch under a condition", mutate(MAIN_RS, "    if let Some(dial_args) = parse_dial_args() {", "    if cfg!(not(test)) { if let Some(dial_args) = parse_dial_args() {").replacen("        return;\n    }\n\n    // If we cannot outlive", "        return;\n    } }\n\n    // If we cannot outlive", 1)),
        ("the dial arguments filtered away", mutate(MAIN_RS, "if let Some(dial_args) = parse_dial_args() {", "if let Some(dial_args) = parse_dial_args().filter(|_| false) {")),
        ("a second parse of the arguments", mutate(MAIN_RS, "    let survivable = match detach::assert_survivable() {", "    let _again = parse_dial_args();\n    let survivable = match detach::assert_survivable() {")),
        ("the mode publishing the record", mutate(MAIN_RS, "    let endpoint = transport::Endpoint(args.connect_pipe);\n", "    let endpoint = transport::Endpoint(args.connect_pipe);\n    let _ = std::env::var(\"TERMFLOW_PTY_RECORD\");\n")),
        ("the non-Windows mode publishing the record", mutate(MAIN_RS, "async fn run_dial_out_mode(_args: DialArgs) {\n", "async fn run_dial_out_mode(_args: DialArgs) {\n    let _ = host_capabilities(true);\n")),
        ("the record marker renamed away", mutate(MAIN_RS, "termflow_pty_protocol::write_record(&path, &rec)", "termflow_pty_protocol::publish_record(&path, &rec)")),
    ];
    for (name, main_rs) in main_cases {
        let verdict = check(&main_rs, DIAL_RS);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
    let dial_cases: Vec<(&str, String)> = vec![
        ("the dial transport writes a record", format!("{DIAL_RS}\nfn leak(p: &std::path::Path, r: &termflow_pty_protocol::HostRecord) {{ let _ = termflow_pty_protocol::write_record(p, r); }}\n")),
        ("the dial transport heals a record", format!("{DIAL_RS}\nfn leak() {{ heal_record(&None); }}\n")),
        ("serve_dial gone", DIAL_RS.replace("pub async fn serve_dial", "pub async fn serve_other")),
    ];
    for (name, dial_rs) in dial_cases {
        let verdict = check(MAIN_RS, &dial_rs);
        eprintln!("{name} => {verdict:?}");
        assert!(verdict.is_err(), "the census let this mutation through: {name}");
    }
}

#[test]
fn prose_naming_the_publishers_in_the_dial_out_code_is_not_a_violation() {
    let commented = mutate(
        MAIN_RS,
        "    let endpoint = transport::Endpoint(args.connect_pipe);\n",
        "    // never write_record( or TERMFLOW_PTY_RECORD or host_capabilities( here\n    let endpoint = transport::Endpoint(args.connect_pipe);\n",
    );
    check(&commented, &format!("{DIAL_RS}\n// no HostRecord, no heal_record\n")).unwrap();
}
