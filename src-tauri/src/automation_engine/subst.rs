//! The `$0` / `$1` / `${name}` / `$$` grammar, and the one function that applies it.
//!
//! **Its own module because there are two callers and they must never disagree.** `run_send`
//! types the message into a pty; `dry.rs` renders "would type …" for the Test button. A
//! substitution that lands in one makes the preview lie about the other (plan 032 §1.1).
//!
//! **A `$` that is not a token stays a literal `$`.** `awk '{print $1}'` is a message somebody
//! has already written, and the opt-in `ActionStep.substitute` flag (§4.2) is what keeps it
//! working — but even with substitution on, `$x` and a trailing `$` are text.

use crate::automation_engine::eval::Captures;
use std::fmt;

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

/// Resolve every token, or name the first one that cannot be resolved.
///
/// A group that EXISTS in the pattern but did not participate resolves to the empty string —
/// that is what an optional group is for. A group the pattern does not have is an error, and
/// the caller refuses the send (§4.4). The named form is symmetric with the positional one:
/// `has_name(k)` is `count()`'s counterpart, so `${retry}` on a declared-but-absent named group
/// substitutes `""` exactly like an in-range `$3` that did not participate, while `${nope}` on an
/// undeclared name errors exactly like an out-of-range `$5`.
pub fn substitute(message: &str, caps: Option<&Captures>) -> Result<String, SubstError> {
    let mut out = String::new();
    for (lit, tok) in scan(message) {
        out.push_str(&lit);
        let Some(tok) = tok else { continue };
        let caps = caps.ok_or_else(|| SubstError(tok.clone()))?;
        let resolved = match &tok {
            Token::Whole => caps.group(0).unwrap_or(""),
            Token::Group(n) => {
                if *n > caps.count() {
                    return Err(SubstError(tok.clone()));
                }
                caps.group(*n).unwrap_or("")
            }
            Token::Named(k) => {
                if !caps.has_name(k) {
                    return Err(SubstError(tok.clone()));
                }
                caps.name(k).unwrap_or("")
            }
        };
        out.push_str(resolved);
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
        }
    }

    #[test]
    fn a_token_beyond_the_pattern_is_an_error_not_a_literal() {
        // §4.4's last row: refuse the send. Typing "Fix the $5 failing tests" into a
        // live agent is the "misleading message" the brief forbids.
        let err = substitute("cost $5", Some(&caps())).unwrap_err();
        assert_eq!(err.to_string(), "$5");
    }

    #[test]
    fn an_unknown_named_group_is_an_error() {
        assert_eq!(substitute("${nope}", Some(&caps())).unwrap_err().to_string(), "${nope}");
    }

    #[test]
    fn a_declared_named_group_that_did_not_participate_substitutes_empty() {
        // §4.4 row 3, named side: a legitimate optional group such as `(?<retry>\d+)?` that did
        // not match must not refuse the send — it substitutes "", exactly like the positional
        // "$3" case above, not like "${nope}".
        assert_eq!(substitute("retries: ${retry}", Some(&caps())).unwrap(), "retries: ");
    }

    #[test]
    fn two_digit_groups_need_braces() {
        let mut c = caps();
        while c.groups.len() < 13 {
            c.groups.push(Some(format!("g{}", c.groups.len())));
        }
        assert_eq!(substitute("${12}", Some(&c)).unwrap(), "g12");
        // "$12" is group 1 followed by a literal 2 — the standard regex-replacement reading,
        // and the reason ${} exists at all.
        assert_eq!(substitute("$12", Some(&c)).unwrap(), "172");
    }

    #[test]
    fn with_no_captures_every_token_is_an_error() {
        // A schedule rule has no parse step. Validation blocks this (T6), but if it is
        // ever reached the send must be refused, not sent with "$1" in it.
        assert_eq!(substitute("hi $1", None).unwrap_err().to_string(), "$1");
    }

    #[test]
    fn empty_braces_are_literal_text() {
        // `${}` names nothing; the brief's table never says what this does. Decided: literal
        // text, same family as "$x" and a trailing "$" — not an error, since nothing was named.
        assert_eq!(substitute("cost ${} here", Some(&caps())).unwrap(), "cost ${} here");
    }

    #[test]
    fn brace_content_that_is_not_purely_digits_is_a_named_lookup() {
        // "${1x}" is not all-digit, so it scans as Named("1x") rather than Group(1) — and since
        // the pattern declares no such name, it errors like any other unknown name.
        assert_eq!(substitute("${1x}", Some(&caps())).unwrap_err().to_string(), "${1x}");
    }
}
