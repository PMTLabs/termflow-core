//! The `$0` / `$1` / `${name}` / `$$` grammar, and the one function that applies it.
//!
//! **Its own module because there are two callers and they must never disagree.** `run_send`
//! types the message into a pty; `dry.rs` renders "would type …" for the Test button. A
//! substitution that lands in one makes the preview lie about the other (plan 032 §1.1).
//!
//! **A `$` that is not a token stays a literal `$`.** `awk '{print $1}'` is a message somebody
//! has already written, and the opt-in `ActionStep.substitute` flag (§4.2) is what keeps it
//! working — but even with substitution on, `$x` and a trailing `$` are text. The shared fixture
//! pins both token recognition and the rendered substitution result on this side and the renderer.

use crate::automation_engine::eval::Captures;
use std::fmt;

pub const RESERVED_NAMES: [&str; 4] = [
    "terminal.id",
    "terminal.title",
    "terminal.cwd",
    "time",
];

/// Values available to message substitutions independently of regex captures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reserved {
    pub terminal_id: String,
    pub terminal_title: Option<String>,
    pub terminal_cwd: Option<String>,
    pub time: String,
}

impl Reserved {
    /// The bag for one send: the id, the DECIDE-time title, the FIRE-time cwd and the clock.
    ///
    /// **Title and cwd are scrubbed of control characters here, once, for both builders.** They are
    /// the two values a person or a filesystem can spell: a pane can be renamed through the API to
    /// anything, and a directory on Linux/macOS may be called `\x1b[201~\r…`. Both are about to be
    /// typed into a pty inside a bracketed paste (`automation::send::deliver`), and an ESC or CR
    /// inside them would close the paste early and submit the rest — a wider exposure than `$1`,
    /// which is bounded to screen text xterm has already stripped of C0/ESC. The id is ours and the
    /// time is formatted here, so neither needs it.
    pub fn for_send(
        terminal_id: &str,
        terminal_title: Option<String>,
        terminal_cwd: Option<String>,
        at_ms: i64,
    ) -> Self {
        Self {
            terminal_id: terminal_id.to_string(),
            terminal_title: terminal_title.map(scrub_control_chars),
            terminal_cwd: terminal_cwd.map(scrub_control_chars),
            time: Self::time_from_ms(at_ms),
        }
    }

    /// `${time}` for a millisecond Unix timestamp, as local wall-clock `YYYY-MM-DD HH:MM:SS`.
    ///
    /// The same UTC-then-`with_timezone` conversion as `schedule::local_now`, for the same reason it
    /// gives: UTC→local is total (DST ambiguity only exists the other way), and an out-of-range
    /// `ms` — which `now_ms()` cannot produce — falls to the epoch rather than to a SECOND read of
    /// the clock, so a crossing's `${time}` is always its own `at_ms`.
    pub fn time_from_ms(ms: i64) -> String {
        use chrono::{DateTime, Local, Utc};

        DateTime::from_timestamp_millis(ms)
            .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
            .with_timezone(&Local)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    }

    /// Fixed values for the save-time validator (`automation_validation::rendered_webhook_body`)
    /// and its tests. Mirrored by `webhookSampleValues` in `automationValidation.ts`.
    ///
    /// The title carries a `"` and the cwd a `\` on purpose: they are the two characters
    /// `ValueEscape::JsonString` exists for, so a Custom body's JSON check can only pass on a
    /// rendering that substituted AND escaped — a raw rendering, or a validator that never
    /// substituted, is told apart by the value, not by the placeholder's own quotes.
    pub fn sample() -> Self {
        Self {
            terminal_id: "tm-sample".into(),
            terminal_title: Some("[terminal.title] \"quoted\"".into()),
            terminal_cwd: Some("[terminal.cwd]\\sub".into()),
            time: "[time]".into(),
        }
    }

    fn get(&self, name: &str) -> Option<&str> {
        match name {
            "terminal.id" => Some(&self.terminal_id),
            "terminal.title" => Some(self.terminal_title.as_deref().unwrap_or("")),
            "terminal.cwd" => Some(self.terminal_cwd.as_deref().unwrap_or("")),
            "time" => Some(&self.time),
            _ => None,
        }
    }
}

pub fn is_reserved(name: &str) -> bool {
    RESERVED_NAMES.contains(&name)
}

/// How a resolved VALUE is written into the message. The literal text around it is never touched.
///
/// `JsonString` is for a body the sender posts byte-for-byte as JSON (`WebhookProvider::Custom`):
/// every value lands inside a JSON string the user wrote, so a Windows path (`D:\\src`) or a
/// title with a quote must arrive as a JSON string FRAGMENT — `D:\\\\src`, `\\"` — or the whole
/// body is malformed. The preset providers serialise the finished message themselves, so `Raw`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueEscape {
    Raw,
    JsonString,
}

/// `serde_json`'s own escaping of `value`, minus the quotes it wraps a string in.
fn json_string_fragment(value: &str) -> String {
    let quoted = serde_json::to_string(value).expect("a &str is always serialisable as JSON");
    quoted[1..quoted.len() - 1].to_string()
}

/// Drop every C0/C1/ESC character. Printable text — including spaces and every non-ASCII letter —
/// passes through untouched, so a title or path that never carried one is returned as it was.
fn scrub_control_chars(value: String) -> String {
    if value.chars().any(char::is_control) {
        value.chars().filter(|c| !c.is_control()).collect()
    } else {
        value
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    Whole,
    Group(usize),
    Named(String),
}

impl fmt::Display for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Token::Whole => write!(f, "$0"),
            Token::Group(n) => write!(f, "${n}"),
            Token::Named(k) => write!(f, "${{{k}}}"),
        }
    }
}

/// A token the message names and the pattern cannot supply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubstError(pub Token);

impl fmt::Display for SubstError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Walk the message once, yielding `(literal_prefix, Option<token>)` pairs.
///
/// One scanner, so `substitute` and `tokens_used` cannot recognise different grammars —
/// which would let validation pass a message the send then refuses.
fn scan(message: &str) -> Vec<(String, Option<Token>)> {
    let b: Vec<char> = message.chars().collect();
    let mut out = Vec::new();
    let mut lit = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != '$' {
            lit.push(b[i]);
            i += 1;
            continue;
        }
        // `$$` -> a literal dollar, and the second `$` is consumed so `$$1` is `$1`.
        if i + 1 < b.len() && b[i + 1] == '$' {
            lit.push('$');
            i += 2;
            continue;
        }
        if i + 1 < b.len() && b[i + 1] == '{' {
            if let Some(close) = b[i + 2..].iter().position(|c| *c == '}') {
                let name: String = b[i + 2..i + 2 + close].iter().collect();
                if !name.is_empty() {
                    let tok = if name.chars().all(|c| c.is_ascii_digit()) {
                        name.parse::<usize>().map(Token::Group).unwrap_or(Token::Named(name.clone()))
                    } else {
                        Token::Named(name)
                    };
                    out.push((std::mem::take(&mut lit), Some(tok)));
                    i += 3 + close;
                    continue;
                }
            }
        }
        if i + 1 < b.len() && b[i + 1].is_ascii_digit() {
            // ONE digit. `$12` is group 1 then a literal `2`; `${12}` is group 12.
            let n = b[i + 1].to_digit(10).unwrap() as usize;
            out.push((std::mem::take(&mut lit), Some(if n == 0 { Token::Whole } else { Token::Group(n) })));
            i += 2;
            continue;
        }
        // A `$` before anything else is a literal `$`.
        lit.push('$');
        i += 1;
    }
    out.push((lit, None));
    out
}

/// Every token the message names, in order, without duplicates removed.
pub fn tokens_used(message: &str) -> Vec<Token> {
    scan(message).into_iter().filter_map(|(_, t)| t).collect()
}

/// Whether the message names the given token after applying the grammar's escape rules.
pub fn names_token(message: &str, name: &str) -> bool {
    tokens_used(message)
        .iter()
        .any(|token| matches!(token, Token::Named(token_name) if token_name == name))
}

/// Resolve every token, or name the first one that cannot be resolved.
///
/// A group that EXISTS in the pattern but did not participate resolves to the empty string —
/// that is what an optional group is for. A group the pattern does not have is an error, and
/// the caller refuses the send (§4.4). The named form is symmetric with the positional one:
/// `has_name(k)` is `count()`'s counterpart, so `${retry}` on a declared-but-absent named group
/// substitutes `""` exactly like an in-range `$3` that did not participate, while `${nope}` on an
/// undeclared name errors exactly like an out-of-range `$5`.
pub fn substitute(
    message: &str,
    caps: Option<&Captures>,
    reserved: &Reserved,
) -> Result<String, SubstError> {
    substitute_escaped(message, caps, reserved, ValueEscape::Raw)
}

/// [`substitute`], with every resolved value written through `escape` — see [`ValueEscape`].
pub fn substitute_escaped(
    message: &str,
    caps: Option<&Captures>,
    reserved: &Reserved,
    escape: ValueEscape,
) -> Result<String, SubstError> {
    let mut out = String::new();
    for (lit, tok) in scan(message) {
        out.push_str(&lit);
        let Some(tok) = tok else { continue };
        let resolved = match &tok {
            Token::Whole => caps
                .ok_or_else(|| SubstError(tok.clone()))?
                .group(0)
                .unwrap_or(""),
            Token::Group(n) => {
                let caps = caps.ok_or_else(|| SubstError(tok.clone()))?;
                if *n > caps.count() {
                    return Err(SubstError(tok.clone()));
                }
                caps.group(*n).unwrap_or("")
            }
            Token::Named(k) => {
                if let Some(caps) = caps {
                    if caps.has_name(k) {
                        caps.name(k).unwrap_or("")
                    } else if let Some(value) = reserved.get(k) {
                        value
                    } else {
                        return Err(SubstError(tok.clone()));
                    }
                } else if let Some(value) = reserved.get(k) {
                    value
                } else {
                    return Err(SubstError(tok.clone()));
                }
            }
        };
        match escape {
            ValueEscape::Raw => out.push_str(resolved),
            ValueEscape::JsonString => out.push_str(&json_string_fragment(resolved)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// `$3` is declared by the pattern (four groups incl. `$0`) but did not participate.
    /// `retry` is a declared-but-absent NAMED group — the row the original brief's fixture
    /// did not cover (`Captures.named` moved to `BTreeMap<String, Option<String>>` in Task 2's
    /// review so the named side can express the same distinction the positional side gets from
    /// `count()`).
    fn caps() -> Captures {
        Captures {
            groups: vec![
                Some("FAILED 17 tests in a.ts".into()), // $0
                Some("17".into()),                      // $1
                Some("a.ts".into()),                    // $2
                None,                                   // $3 — present in the pattern, did not match
            ],
            named: BTreeMap::from([
                ("file".to_string(), Some("a.ts".to_string())),
                ("retry".to_string(), None), // declared, did not participate
            ]),
        }
    }

    /// The shared grammar fixture's declared capture universe: enough numbered slots to exercise
    /// `${12}`, plus both names it uses. Values are deliberately mechanical so a rendered row
    /// exposes scanner/literal drift rather than depending on the production-shaped `caps()`.
    /// The group values are BRACKETED deliberately. With a bare `g{n}`, group 12 renders `g12`
    /// and so does group 1 followed by a literal `2` — so `$12` and `${12}`, the one pair the
    /// fixture exists to tell apart, produced the same string and a resolver that read `Group(12)`
    /// as group 1 plus `"2"` passed every row. The brackets make a multi-digit group unforgeable by
    /// concatenation, for every such pair rather than only for 12.
    fn fixture_caps() -> Captures {
        Captures {
            groups: std::iter::once(Some("whole".to_string()))
                .chain((1..=12).map(|n| Some(format!("[g{n}]"))))
                .collect(),
            named: BTreeMap::from([
                ("file".to_string(), Some("file".to_string())),
                ("1x".to_string(), Some("one-x".to_string())),
            ]),
        }
    }

    fn fixture_reserved() -> Reserved {
        Reserved {
            terminal_id: "tm-fx".into(),
            terminal_title: Some("fx-title".into()),
            terminal_cwd: Some("/fx".into()),
            time: "2026-01-02 03:04:05".into(),
        }
    }

    #[test]
    fn the_shared_token_fixture_agrees_with_the_scanner() {
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            input: String,
            tokens: Vec<FixtureToken>,
            rendered: String,
        }
        #[derive(serde::Deserialize)]
        #[serde(tag = "kind", rename_all = "lowercase")]
        enum FixtureToken {
            Group { n: usize },
            Named { name: String },
        }

        let raw = include_str!("../../../src/renderer/components/Automation/__fixtures__/automationTokenCases.json");
        let fixture: Fixture = serde_json::from_str(raw).expect("the shared token fixture parses");

        // A fixture that shrank to nothing would pass by having nothing to disagree about. A floor,
        // not an exact count, so adding a grammar case is not a two-file edit.
        assert!(fixture.cases.len() >= 17, "the shared token fixture has shrunk to {} cases", fixture.cases.len());

        for case in fixture.cases {
            let want: Vec<Token> = case
                .tokens
                .into_iter()
                .map(|token| match token {
                    FixtureToken::Group { n } if n == 0 => Token::Whole,
                    FixtureToken::Group { n } => Token::Group(n),
                    FixtureToken::Named { name } => Token::Named(name),
                })
                .collect();
            assert_eq!(tokens_used(&case.input), want, "input was {:?}", case.input);
            assert_eq!(
                substitute(&case.input, Some(&fixture_caps()), &fixture_reserved())
                    .expect("fixture captures resolve every token"),
                case.rendered,
                "input was {:?}",
                case.input,
            );
        }
    }

    #[test]
    fn a_token_beyond_the_pattern_is_an_error_not_a_literal() {
        // §4.4's last row: refuse the send. Typing "Fix the $5 failing tests" into a
        // live agent is the "misleading message" the brief forbids.
        let err = substitute("cost $5", Some(&caps()), &Reserved::sample()).unwrap_err();
        assert_eq!(err.to_string(), "$5");
    }

    #[test]
    fn an_unknown_named_group_is_an_error() {
        assert_eq!(
            substitute("${nope}", Some(&caps()), &Reserved::sample())
                .unwrap_err()
                .to_string(),
            "${nope}"
        );
    }

    #[test]
    fn a_declared_named_group_that_did_not_participate_substitutes_empty() {
        // §4.4 row 3, named side: a legitimate optional group such as `(?<retry>\d+)?` that did
        // not match must not refuse the send — it substitutes "", exactly like the positional
        // "$3" case above, not like "${nope}".
        assert_eq!(
            substitute("retries: ${retry}", Some(&caps()), &Reserved::sample()).unwrap(),
            "retries: "
        );
    }

    #[test]
    fn two_digit_groups_need_braces() {
        let mut c = caps();
        while c.groups.len() < 13 {
            c.groups.push(Some(format!("g{}", c.groups.len())));
        }
        assert_eq!(substitute("${12}", Some(&c), &Reserved::sample()).unwrap(), "g12");
        // "$12" is group 1 followed by a literal 2 — the standard regex-replacement reading,
        // and the reason ${} exists at all.
        assert_eq!(substitute("$12", Some(&c), &Reserved::sample()).unwrap(), "172");
    }

    #[test]
    fn with_no_captures_every_token_is_an_error() {
        // A schedule rule has no parse step. Validation blocks this (T6), but if it is
        // ever reached the send must be refused, not sent with "$1" in it.
        assert_eq!(
            substitute("hi $1", None, &Reserved::sample())
                .unwrap_err()
                .to_string(),
            "$1"
        );
    }

    #[test]
    fn empty_braces_are_literal_text() {
        // `${}` names nothing; the brief's table never says what this does. Decided: literal
        // text, same family as "$x" and a trailing "$" — not an error, since nothing was named.
        assert_eq!(
            substitute("cost ${} here", Some(&caps()), &Reserved::sample()).unwrap(),
            "cost ${} here"
        );
    }

    #[test]
    fn brace_content_that_is_not_purely_digits_is_a_named_lookup() {
        // "${1x}" is not all-digit, so it scans as Named("1x") rather than Group(1) — and since
        // the pattern declares no such name, it errors like any other unknown name.
        assert_eq!(
            substitute("${1x}", Some(&caps()), &Reserved::sample())
                .unwrap_err()
                .to_string(),
            "${1x}"
        );
    }

    #[test]
    fn reserved_resolve_without_captures() {
        let reserved = Reserved {
            terminal_id: "tm-1".into(),
            terminal_title: None,
            terminal_cwd: Some("/work".into()),
            time: "2026-01-02 03:04:05".into(),
        };
        assert_eq!(
            substitute(
                "${terminal.id}|${terminal.title}|${terminal.cwd}|${time}",
                None,
                &reserved,
            )
            .unwrap(),
            "tm-1||/work|2026-01-02 03:04:05"
        );
    }

    #[test]
    fn a_declared_group_shadows_a_reserved_name() {
        let captures = Captures {
            groups: vec![Some("whole".into()), Some("42".into())],
            named: BTreeMap::from([(String::from("time"), Some(String::from("42")))]),
        };
        assert_eq!(
            substitute("${time}", Some(&captures), &Reserved::sample()).unwrap(),
            "42"
        );
    }

    #[test]
    fn escaped_reserved_token_is_literal_text() {
        assert_eq!(
            substitute("$${time}", None, &Reserved::sample()).unwrap(),
            "${time}"
        );
    }

    /// The paste-breaking bytes: ESC (a bracketed-paste end), CR (a submit) and LF, in both of the
    /// values a person or a filesystem can spell. The id is left alone — it is ours.
    #[test]
    fn a_title_or_cwd_with_control_characters_is_scrubbed_for_the_paste() {
        let reserved = Reserved::for_send(
            "tm-1",
            Some("x\x1b[201~\ry".into()),
            Some("/repo\n\x07b".into()),
            0,
        );
        assert_eq!(reserved.terminal_title.as_deref(), Some("x[201~y"));
        assert_eq!(reserved.terminal_cwd.as_deref(), Some("/repob"));
        assert_eq!(reserved.terminal_id, "tm-1");
    }

    /// The negative control: a value with nothing to scrub is returned exactly as it was, spaces
    /// and non-ASCII included.
    #[test]
    fn a_clean_title_and_cwd_pass_through_the_scrub_untouched() {
        let reserved = Reserved::for_send("tm-1", Some("codex · core".into()), Some("D:\\src core".into()), 0);
        assert_eq!(reserved.terminal_title.as_deref(), Some("codex · core"));
        assert_eq!(reserved.terminal_cwd.as_deref(), Some("D:\\src core"));
    }

    /// `JsonString` escapes the VALUES and only the values: the braces and quotes the user wrote
    /// around `$1` and `${terminal.cwd}` are literal text and go out as they are.
    #[test]
    fn json_string_escape_touches_values_and_never_the_literal_text() {
        let reserved = Reserved::for_send("tm-1", Some("say \"hi\"".into()), Some("D:\\src\\core".into()), 0);
        let body = r#"{"cwd":"${terminal.cwd}","t":"${terminal.title}","n":"$2"}"#;
        let rendered = substitute_escaped(body, Some(&caps()), &reserved, ValueEscape::JsonString).unwrap();
        assert_eq!(rendered, r#"{"cwd":"D:\\src\\core","t":"say \"hi\"","n":"a.ts"}"#);
        let parsed: serde_json::Value = serde_json::from_str(&rendered).unwrap();
        assert_eq!(parsed["cwd"], "D:\\src\\core");
        assert_eq!(parsed["t"], "say \"hi\"");
    }

    /// The negative control: `Raw` is what every other caller gets, and it leaves the value alone.
    #[test]
    fn raw_escape_writes_the_value_verbatim() {
        let reserved = Reserved::for_send("tm-1", None, Some("D:\\src".into()), 0);
        assert_eq!(
            substitute_escaped("in ${terminal.cwd}", None, &reserved, ValueEscape::Raw).unwrap(),
            "in D:\\src"
        );
    }

    /// The value, not only the shape: a fixed string of the right shape must fail here, so the
    /// engine tests that bracket `${time}` between two clock reads have something to lean on.
    /// The expected value comes from chrono's OTHER local-time path (`Local.timestamp_millis_opt`)
    /// rather than the UTC-then-`with_timezone` one the function uses.
    #[test]
    fn time_from_ms_renders_that_instant_in_local_time() {
        use chrono::{Local, TimeZone};
        let ms = 1_609_459_445_000;
        let expected = Local
            .timestamp_millis_opt(ms)
            .single()
            .expect("a real instant has one local rendering")
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();
        assert_eq!(Reserved::time_from_ms(ms), expected);
        assert_ne!(
            Reserved::time_from_ms(ms + 1_000),
            expected,
            "one second later must render differently"
        );
        assert!(
            regex::Regex::new(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")
                .unwrap()
                .is_match(&expected),
            "unexpected local timestamp format: {expected}"
        );
    }

    /// `RESERVED_NAMES` (what the validators exempt) and `Reserved::get` (what a send resolves)
    /// are two lists; a name in one and not the other is a message that saves and then fails to
    /// send, or the reverse. The four names are spelled out here rather than read from the
    /// constant, so a constant that lost one fails instead of shrinking the loop.
    #[test]
    fn every_reserved_name_is_exempt_and_resolves() {
        assert_eq!(RESERVED_NAMES, ["terminal.id", "terminal.title", "terminal.cwd", "time"]);
        let reserved = Reserved::sample();
        for name in ["terminal.id", "terminal.title", "terminal.cwd", "time"] {
            assert!(is_reserved(name), "{name} is not exempt");
            assert!(reserved.get(name).is_some(), "{name} does not resolve");
            assert_eq!(
                substitute(&format!("${{{name}}}"), None, &reserved).unwrap(),
                reserved.get(name).unwrap(),
                "{name} did not substitute to its own value"
            );
        }
        assert!(!is_reserved("terminal.nope"));
        assert!(reserved.get("terminal.nope").is_none());
    }
}
