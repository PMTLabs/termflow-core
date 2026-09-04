//! The Rust mirror of the editor's `automationValidation`.
//!
//! Two implementations of one rule set, sharing ONE case fixture so they cannot diverge silently. The
//! backend owns "is this rule allowed to run" and must not be talked into enabling an invalid rule by
//! a stale renderer: `set_automation_enabled` and any save with `enabled = true` re-check and refuse.
//! The boundary audit found the enable path bypassed entirely — the editor gated its own toggle, the
//! store validated nothing semantic, and the engine refused only an uncompilable pattern, so a rule
//! with no terminals and an empty message went live straight from the list row. Plan §7.8, R10.
//!
//! A `Problem` carries `severity`: only `blocks` gates the toggle. `warns` exists for the case a rule
//! whose own message text matches its own pattern (the echo failure of §2.6) and for a pattern with
//! more than one capture group (§2.2b) — unusual, not invalid, and losing work to a validation rule is
//! its own bug. **Save is never gated.**
//!
//! **M2 lands `compile` and the PATTERN rules** — the ones §2.2b specifies and §10.2b gates, which are
//! about the parse step alone and need nothing but the graph. **M3 lands the whole-rule rules** (no
//! terminals, empty message, the echo warning) with the enable path, and **M5 the shared fixture**.

use regex::{Regex, RegexBuilder};

use crate::automation_store::{AutomationGraph, Keep};

/// Whether a problem stops the rule running, or merely tells the user something.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Blocks,
    Warns,
}

/// One thing wrong with a draft, in the words the editor shows.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub severity: Severity,
    /// Which step owns it, so the editor can point at the right panel: `parse`, `cond`, `action`,
    /// `monitor`, `targets`.
    pub field: String,
    pub message: String,
}

impl Problem {
    pub fn blocks(&self) -> bool {
        self.severity == Severity::Blocks
    }

    fn new(severity: Severity, field: &str, message: impl Into<String>) -> Self {
        Self { severity, field: field.to_string(), message: message.into() }
    }
}

/// Compile a user pattern, once, at rule load.
///
/// `size_limit(1 << 20)` bounds the compiled program rather than the input. Rust's `regex` has no
/// backtracking and guarantees linear-time matching, so a pattern typed into the editor cannot hang
/// the 250 ms evaluation loop — a guarantee the renderer's `RegExp` preview cannot make, which is why
/// compilation is mandatory here rather than merely convenient: JS regex syntax is a superset, so a
/// pattern that previews fine can fail to build.
pub fn compile(find: &str) -> Result<Regex, String> {
    RegexBuilder::new(find)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| e.to_string())
}

/// Everything wrong with a rule's PARSE step. Ordered blocks-first, so a caller showing one shows the
/// one that matters.
pub fn pattern_problems(graph: &AutomationGraph) -> Vec<Problem> {
    let mut out = Vec::new();
    let find = graph.parse.find.trim();

    if find.is_empty() {
        out.push(Problem::new(Severity::Blocks, "parse", "Enter something to look for."));
        return out;
    }

    let compiled = match compile(find) {
        Ok(re) => re,
        Err(e) => {
            out.push(Problem::new(
                Severity::Blocks,
                "parse",
                format!("That pattern could not be understood: {}", first_line(&e)),
            ));
            return out;
        }
    };

    // `captures_len()` counts group 0, so a pattern with no capture group reports 1.
    let groups = compiled.captures_len().saturating_sub(1);
    let has_named_value = compiled.capture_names().any(|n| n == Some("value"));

    if graph.parse.keep == Keep::Brackets && groups == 0 {
        // Never a silent fall-back to the whole match: the user asked for the bracketed part, and
        // comparing something else is how a rule types the wrong thing into a terminal.
        out.push(Problem::new(
            Severity::Blocks,
            "parse",
            "This pattern has no brackets, so there is no value to keep. \
             Put brackets around the part you want, or keep the whole match instead.",
        ));
    }

    if graph.parse.keep == Keep::Brackets && groups > 1 && !has_named_value {
        out.push(Problem::new(
            Severity::Warns,
            "parse",
            "This pattern has more than one bracketed group. The first one is used; \
             name one of them `value` to choose a different one.",
        ));
    }

    out
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or(s).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation_store::{
        ActionStep, Cadence, CompareOp, CondKind, CondStep, MonitorStep, ParsePreset, ParseStep,
        ReadMode, SendTo,
    };

    fn graph(find: &str, keep: Keep) -> AutomationGraph {
        AutomationGraph {
            monitor: MonitorStep { read: ReadMode::NewOutput, cadence: Cadence::OnOutput, every_ms: 0 },
            parse: ParseStep { preset: ParsePreset::Custom, literal: None, find: find.into(), keep },
            cond: CondStep { kind: CondKind::Number, op: Some(CompareOp::Gt), threshold: Some(25.0) },
            action: ActionStep {
                message: "m".into(),
                send_to: SendTo::Matched,
                submit: true,
                cli_type: "default".into(),
            },
        }
    }

    fn blocks(g: &AutomationGraph) -> bool {
        pattern_problems(g).iter().any(Problem::blocks)
    }

    #[test]
    fn the_canonical_pattern_is_clean() {
        assert!(pattern_problems(&graph(r"ctx:(\d+)%", Keep::Brackets)).is_empty());
    }

    /// §10.2b's blocking half — the counterpart to `extract` refusing to fall back.
    #[test]
    fn brackets_with_no_capture_group_blocks() {
        assert!(blocks(&graph(r"\d+", Keep::Brackets)));
        assert!(
            !blocks(&graph(r"\d+", Keep::Whole)),
            "the same pattern is fine when the whole match IS the value"
        );
    }

    #[test]
    fn an_uncompilable_pattern_blocks_and_says_why() {
        let problems = pattern_problems(&graph(r"ctx:(\d+%", Keep::Brackets));
        assert!(problems.iter().any(Problem::blocks));
        assert!(
            problems[0].message.contains("could not be understood"),
            "got {:?}",
            problems[0].message
        );
        // A blocked compile must not also report "no brackets" — one cause, one message.
        assert_eq!(problems.len(), 1);
    }

    #[test]
    fn an_empty_pattern_blocks() {
        assert!(blocks(&graph("   ", Keep::Brackets)));
        assert_eq!(pattern_problems(&graph("", Keep::Brackets)).len(), 1);
    }

    /// More than one group is unusual, not invalid — losing a user's work to a validation rule is its
    /// own bug.
    #[test]
    fn more_than_one_group_warns_but_does_not_block() {
        let problems = pattern_problems(&graph(r"(\w+):(\d+)%", Keep::Brackets));
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].severity, Severity::Warns);
        assert!(!blocks(&graph(r"(\w+):(\d+)%", Keep::Brackets)));
    }

    /// Naming a group `value` says which one is meant, so there is nothing to warn about.
    #[test]
    fn a_named_value_group_silences_the_multi_group_warning() {
        assert!(pattern_problems(&graph(r"(?<name>\w+):(?<value>\d+)%", Keep::Brackets)).is_empty());
    }

    /// `keep: whole` does not care how many groups there are.
    #[test]
    fn keep_whole_never_warns_about_groups() {
        assert!(pattern_problems(&graph(r"(\w+):(\d+)%", Keep::Whole)).is_empty());
    }

    /// JS regex syntax is a superset, so a pattern that previews fine in the editor can fail here —
    /// which is exactly why compilation is mandatory backend-side.
    #[test]
    fn a_js_only_construct_is_refused_rather_than_silently_accepted() {
        assert!(compile(r"(?=lookahead)").is_err(), "Rust's regex has no lookahead");
        assert!(compile(r"ctx:(\d+)%").is_ok());
    }
}
