//! `label_at` — the ONE terminal-name resolver for the Automations feature.
//!
//! One implementation, because the boundary audit found two and **the wrong one sat on the write
//! path**: the engine's read `state.terminals[pc].name`, which is `Terminal-{shell}` for every
//! renderer-created terminal, so the log's Name column would have shown a guess for every unrenamed
//! terminal — precisely what R17 forbids — while the correct resolver sat dead behind a passing test.
//!
//! Resolution order (plan §4.5):
//!   1. the live terminal's `display_label`;
//!   2. its `name`, ONLY when that is not the derived placeholder — this preserves an agent- or
//!      fleet-supplied name while refusing `Terminal-powershell`, a shell label dressed as a name;
//!   3. the rule's own last-known label snapshot for that `tm-`;
//!   4. `None`, stored as NULL and rendered as an empty column. **Never invented.**
//!
//! Called at DECIDE time and carried in the pending-send record, never at write time: the
//! `failed - the terminal closed` entry is written after the terminal is gone.

/// Everything the four steps can draw on. All borrowed, because every caller already holds these.
#[derive(Debug, Default, Clone, Copy)]
pub struct LabelInputs<'a> {
    /// The pushed-down tab/pane title. `None` when the terminal is gone, or before the renderer's
    /// first push.
    pub display_label: Option<&'a str>,
    /// `Terminal.name`. `None` when the terminal is gone.
    pub name: Option<&'a str>,
    /// The shell the terminal was spawned with — needed only to recognise the derived placeholder.
    pub shell: Option<&'a str>,
    /// `automation_targets.label` for this `(rule, tm)`.
    pub snapshot: Option<&'a str>,
}

/// True when `name` is the spawn-time placeholder rather than a name anyone chose.
///
/// `commands.rs` writes `Terminal-{shell}` for every renderer-created terminal because the bridge's
/// `createTerminal` drops its `name` argument. Accepting it would put a shell label in the log's Name
/// column for most terminals, which looks correct and is not.
fn is_derived_placeholder(name: &str, shell: Option<&str>) -> bool {
    match shell {
        Some(sh) => name == format!("Terminal-{}", sh),
        // With no shell to compare against, refuse the shape rather than guess: `Terminal-` is never
        // a name a person or an agent chose.
        None => name.starts_with("Terminal-"),
    }
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// The terminal's name for one log entry or one picker row, or `None`. Never invented.
pub fn label_at(inputs: &LabelInputs) -> Option<String> {
    if let Some(label) = non_empty(inputs.display_label) {
        return Some(label.to_string());
    }
    if let Some(name) = non_empty(inputs.name) {
        if !is_derived_placeholder(name, inputs.shell) {
            return Some(name.to_string());
        }
    }
    non_empty(inputs.snapshot).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §10.12 — the four steps, each proved by a case where the step ABOVE it is unavailable, so a
    /// resolver that skips a step fails rather than coincidentally agreeing.
    #[test]
    fn the_four_steps_resolve_in_order() {
        // 1 — the live label wins over everything, including a real agent-supplied name.
        assert_eq!(
            label_at(&LabelInputs {
                display_label: Some("codex · fabric"),
                name: Some("fleet-worker-3"),
                shell: Some("powershell"),
                snapshot: Some("stale"),
            }),
            Some("codex · fabric".to_string())
        );

        // 2 — no live label: an agent- or fleet-supplied name is kept.
        assert_eq!(
            label_at(&LabelInputs {
                display_label: None,
                name: Some("fleet-worker-3"),
                shell: Some("powershell"),
                snapshot: Some("stale"),
            }),
            Some("fleet-worker-3".to_string())
        );

        // 2' — the derived placeholder is REFUSED and falls through to the snapshot.
        assert_eq!(
            label_at(&LabelInputs {
                display_label: None,
                name: Some("Terminal-powershell"),
                shell: Some("powershell"),
                snapshot: Some("remembered"),
            }),
            Some("remembered".to_string()),
            "the derived placeholder is a shell label dressed as a name"
        );

        // 3 — the terminal is gone entirely; the rule's snapshot is all there is.
        assert_eq!(
            label_at(&LabelInputs {
                display_label: None,
                name: None,
                shell: None,
                snapshot: Some("remembered"),
            }),
            Some("remembered".to_string())
        );

        // 4 — nothing at all. NEVER invented.
        assert_eq!(label_at(&LabelInputs::default()), None);
    }

    /// The placeholder check is against THIS terminal's shell, not a fixed list: `Terminal-bash` is a
    /// placeholder for a bash terminal and a legitimate (if odd) name for a powershell one.
    #[test]
    fn the_placeholder_is_recognised_per_shell() {
        let refused = LabelInputs {
            display_label: None,
            name: Some("Terminal-bash"),
            shell: Some("bash"),
            snapshot: None,
        };
        assert_eq!(label_at(&refused), None);

        let kept = LabelInputs {
            display_label: None,
            name: Some("Terminal-bash"),
            shell: Some("powershell"),
            snapshot: None,
        };
        assert_eq!(
            label_at(&kept),
            Some("Terminal-bash".to_string()),
            "it is only a placeholder when it names this terminal's OWN shell"
        );
    }

    /// An empty or whitespace label is not a label. Without this, a pane renamed to "" would push a
    /// blank that beats a perfectly good name.
    #[test]
    fn blank_values_fall_through_rather_than_winning() {
        assert_eq!(
            label_at(&LabelInputs {
                display_label: Some("   "),
                name: Some(""),
                shell: Some("bash"),
                snapshot: Some("remembered"),
            }),
            Some("remembered".to_string())
        );
    }

    /// A label is trimmed, so the picker and the log agree with what the tab shows.
    #[test]
    fn a_label_is_trimmed() {
        assert_eq!(
            label_at(&LabelInputs { display_label: Some("  codex  "), ..Default::default() }),
            Some("codex".to_string())
        );
    }
}
