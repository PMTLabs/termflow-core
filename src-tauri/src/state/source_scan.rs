//! Reading the application's own source in tests that pin how it is wired: the
//! production text of a file, and the body or span of a function in it.
//!
//! Some wiring (anything that needs a Tauri `AppHandle`) cannot be exercised by a
//! unit test on every platform, so a test reads it from source. Everything here
//! understands comments, strings and char literals well enough that a brace or a
//! keyword inside one does not move a boundary.

/// `#[cfg(test)] mod name { ... }` blocks (and `mod name;` declarations) cut out,
/// so what remains is production text.
pub(super) fn without_test_modules(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::new();
    let mut at = 0;
    while let Some(rel) = source[at..].find("#[cfg(") {
        let attr = at + rel;
        let attr_end = source[attr..].find(']').map_or(source.len(), |e| attr + e + 1);
        let attribute = &source[attr..attr_end];
        let after = source[attr_end..].trim_start();
        let is_test_mod = attribute.contains("test") && !attribute.contains("not(") && after.starts_with("mod ");
        if !is_test_mod {
            out.push_str(&source[at..attr_end]);
            at = attr_end;
            continue;
        }
        out.push_str(&source[at..attr]);
        let item = source.len() - after.len();
        let brace = source[item..].find(['{', ';']).map(|i| item + i);
        at = match brace {
            Some(i) if bytes[i] == b';' => i + 1,
            Some(i) => matching_brace(source, i) + 1,
            None => source.len(),
        };
    }
    out.push_str(&source[at..]);
    out
}

/// Index of the `}` closing the `{` at `open`, skipping comments, strings and
/// char literals.
pub(super) fn matching_brace(source: &str, open: usize) -> usize {
    let b = source.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => {
                i += source[i..].find('\n').unwrap_or(b.len() - i);
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += source[i..].find("*/").map_or(b.len() - i, |e| e + 2);
                continue;
            }
            b'"' => {
                let before = &source[..i];
                let hashes = before.bytes().rev().take_while(|c| *c == b'#').count();
                let raw = before[..before.len() - hashes].ends_with('r');
                if raw {
                    let close = format!("\"{}", "#".repeat(hashes));
                    i += 1 + source[i + 1..].find(&close).map_or(b.len(), |e| e + close.len());
                } else {
                    i += 1;
                    while i < b.len() && b[i] != b'"' {
                        i += if b[i] == b'\\' { 2 } else { 1 };
                    }
                    i += 1;
                }
                continue;
            }
            b'\'' if b.get(i + 2) == Some(&b'\'') => {
                i += 3;
                continue;
            }
            b'\'' if b.get(i + 1) == Some(&b'\\') && b.get(i + 3) == Some(&b'\'') => {
                i += 4;
                continue;
            }
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
        i += 1;
    }
    panic!("unbalanced braces in a scanned source file");
}

/// `//` line comments dropped.
pub(super) fn strip_comments(code: &str) -> String {
    code.lines()
        .map(|line| line.find("//").map_or(line, |i| &line[..i]))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Production text with comments dropped, for a test that looks for calls: prose
/// that describes a call must neither satisfy nor trip it.
pub(super) fn production(source: &str) -> String {
    strip_comments(&without_test_modules(&source.replace("\r\n", "\n")))
}

/// The body (braces included) of the function whose text starts with `signature`.
/// Fails loudly when the function is gone: a guard that cannot find what it
/// guards must not pass.
pub(super) fn fn_body(src: &str, signature: &str) -> String {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("`{signature}` not found — this guard must fail loudly, not pass vacuously"));
    let open = src[start..].find('{').map(|i| start + i).expect("a function with a body");
    src[open..=matching_brace(src, open)].to_string()
}

/// Every function in `src` with a body: its name and the byte range of the body.
/// Nested functions are listed too.
pub(super) fn fn_spans(src: &str) -> Vec<(String, std::ops::Range<usize>)> {
    let mut spans = Vec::new();
    let mut from = 0;
    while let Some(rel) = src[from..].find("fn ") {
        let at = from + rel;
        from = at + 3;
        let word_start = src[..at].chars().next_back().is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        if !word_start {
            continue;
        }
        let name: String = src[at + 3..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        if name.is_empty() {
            continue;
        }
        let Some(stop) = src[at..].find(['{', ';']).map(|i| at + i) else { continue };
        if src.as_bytes()[stop] == b';' {
            continue;
        }
        spans.push((name, stop..matching_brace(src, stop) + 1));
    }
    spans
}

/// The innermost function whose body contains byte `at`.
pub(super) fn enclosing_fn(src: &str, at: usize) -> Option<String> {
    fn_spans(src)
        .into_iter()
        .filter(|(_, span)| span.contains(&at))
        .min_by_key(|(_, span)| span.len())
        .map(|(name, _)| name)
}

/// Every `.` call of `method` in `src`, as the name of the function it sits in
/// (`None` outside any function).
pub(super) fn callers_of(src: &str, method_call: &str) -> Vec<Option<String>> {
    src.match_indices(method_call).map(|(at, _)| enclosing_fn(src, at)).collect()
}
