//! The marker grammar and the version comparison live in this table and nowhere
//! else: every row is a whole `(running, notes)` input and the whole result.
use super::*;
use UpdateMode::{Full, Offload};

/// (row name, running build, release notes, expected mode)
type Row = (&'static str, &'static str, Option<&'static str>, UpdateMode);

fn check(rows: &[Row]) {
    let mut wrong = Vec::new();
    for &(name, running, notes, expected) in rows {
        let got = update_mode(running, notes);
        if got != expected {
            wrong.push(format!("{name}: update_mode({running:?}, {notes:?}) = {got:?}, expected {expected:?}"));
        }
    }
    assert!(wrong.is_empty(), "{} row(s) wrong:\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn no_marker_is_an_offload() {
    check(&[
        ("absent notes", "1.0.0", None, Offload),
        ("empty notes", "1.0.0", Some(""), Offload),
        ("whitespace-only notes", "1.0.0", Some(" \r\n\t "), Offload),
        ("notes with no comment at all", "1.0.0", Some("Fixes a crash.\n\n- one\n- two"), Offload),
        ("a different comment", "1.0.0", Some("<!-- reviewed by someone -->"), Offload),
        ("a termflow comment with another key", "1.0.0", Some("<!-- termflow: full-from=9.9.9 -->"), Offload),
        ("the key outside a comment", "1.0.0", Some("termflow: offload-from=9.9.9"), Offload),
        ("the key in a line comment", "1.0.0", Some("// termflow: offload-from=9.9.9"), Offload),
    ]);
}

#[test]
fn a_malformed_marker_is_an_offload_even_when_the_value_is_far_ahead() {
    check(&[
        ("missing '='", "1.0.0", Some("<!-- termflow: offload-from 9.9.9 -->"), Offload),
        ("missing '-->'", "1.0.0", Some("<!-- termflow: offload-from=9.9.9"), Offload),
        ("missing '-->' followed by text", "1.0.0", Some("<!-- termflow: offload-from=9.9.9\nmore notes"), Offload),
        ("missing '<!--'", "1.0.0", Some("termflow: offload-from=9.9.9 -->"), Offload),
        ("missing colon", "1.0.0", Some("<!-- termflow offload-from=9.9.9 -->"), Offload),
        ("missing tag", "1.0.0", Some("<!-- offload-from=9.9.9 -->"), Offload),
        ("wrong tag", "1.0.0", Some("<!-- termflux: offload-from=9.9.9 -->"), Offload),
        ("wrong key", "1.0.0", Some("<!-- termflow: offload_from=9.9.9 -->"), Offload),
        ("key with a suffix", "1.0.0", Some("<!-- termflow: offload-fromage=9.9.9 -->"), Offload),
        ("trailing text after the value", "1.0.0", Some("<!-- termflow: offload-from=9.9.9 please -->"), Offload),
        ("two values", "1.0.0", Some("<!-- termflow: offload-from=9.9.9 offload-from=1.0.0 -->"), Offload),
        ("unterminated comment swallowing the next marker", "1.0.0",
            Some("<!-- termflow: offload-from=\n<!-- termflow: offload-from=9.9.9 -->"), Offload),
        ("non-ASCII where the tag should be", "1.0.0", Some("<!-- termflöw: offload-from=9.9.9 -->"), Offload),
        ("multi-byte char at the tag boundary", "1.0.0", Some("<!-- termfloé: offload-from=9.9.9 -->"), Offload),
        ("empty comment", "1.0.0", Some("<!---->"), Offload),
        ("nested opener inside the value", "1.0.0", Some("<!-- termflow: offload-from=<!--9.9.9 -->"), Offload),
    ]);
}

#[test]
fn an_empty_value_is_an_offload() {
    check(&[
        ("nothing after '='", "1.0.0", Some("<!-- termflow: offload-from= -->"), Offload),
        ("nothing at all after '='", "1.0.0", Some("<!-- termflow: offload-from=-->"), Offload),
        ("only whitespace after '='", "1.0.0", Some("<!-- termflow: offload-from=   \r\n  -->"), Offload),
    ]);
}

#[test]
fn a_value_that_is_not_a_plain_release_version_is_an_offload() {
    check(&[
        ("two fields", "1.0.0", Some("<!-- termflow: offload-from=9.9 -->"), Offload),
        ("one field", "1.0.0", Some("<!-- termflow: offload-from=9 -->"), Offload),
        ("leading v", "1.0.0", Some("<!-- termflow: offload-from=v9.9.9 -->"), Offload),
        ("four fields", "1.0.0", Some("<!-- termflow: offload-from=9.9.9.9 -->"), Offload),
        ("word", "1.0.0", Some("<!-- termflow: offload-from=abc -->"), Offload),
        ("non-numeric field", "1.0.0", Some("<!-- termflow: offload-from=9.x.9 -->"), Offload),
        ("empty field", "1.0.0", Some("<!-- termflow: offload-from=9..9 -->"), Offload),
        ("trailing dot", "1.0.0", Some("<!-- termflow: offload-from=9.9.9. -->"), Offload),
        ("leading zero", "1.0.0", Some("<!-- termflow: offload-from=09.9.9 -->"), Offload),
        ("signed field", "1.0.0", Some("<!-- termflow: offload-from=+9.9.9 -->"), Offload),
        ("negative field", "1.0.0", Some("<!-- termflow: offload-from=-9.9.9 -->"), Offload),
        ("field overflowing u64", "1.0.0",
            Some("<!-- termflow: offload-from=99999999999999999999.0.0 -->"), Offload),
        ("pre-release suffix", "1.0.0", Some("<!-- termflow: offload-from=9.9.9-beta.1 -->"), Offload),
        ("build suffix", "1.0.0", Some("<!-- termflow: offload-from=9.9.9+build5 -->"), Offload),
        ("quoted", "1.0.0", Some("<!-- termflow: offload-from=\"9.9.9\" -->"), Offload),
    ]);
}

#[test]
fn a_floor_above_the_running_build_is_full() {
    check(&[
        ("patch ahead", "1.2.3", Some("<!-- termflow: offload-from=1.2.4 -->"), Full),
        ("minor ahead", "1.2.3", Some("<!-- termflow: offload-from=1.3.0 -->"), Full),
        ("major ahead", "1.2.3", Some("<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("compared as numbers not text (minor)", "1.9.0", Some("<!-- termflow: offload-from=1.10.0 -->"), Full),
        ("compared as numbers not text (major)", "9.0.0", Some("<!-- termflow: offload-from=10.0.0 -->"), Full),
        ("zero running", "0.0.0", Some("<!-- termflow: offload-from=0.0.1 -->"), Full),
        ("floor is a very large number", "1.2.3", Some("<!-- termflow: offload-from=99999999999.0.0 -->"), Full),
    ]);
}

#[test]
fn a_floor_at_or_below_the_running_build_is_an_offload() {
    check(&[
        ("running == floor", "1.2.3", Some("<!-- termflow: offload-from=1.2.3 -->"), Offload),
        ("patch behind", "1.2.4", Some("<!-- termflow: offload-from=1.2.3 -->"), Offload),
        ("minor behind", "1.3.0", Some("<!-- termflow: offload-from=1.2.9 -->"), Offload),
        ("major behind", "2.0.0", Some("<!-- termflow: offload-from=1.9.9 -->"), Offload),
        ("compared as numbers not text (minor)", "1.10.0", Some("<!-- termflow: offload-from=1.9.0 -->"), Offload),
        ("compared as numbers not text (major)", "10.0.0", Some("<!-- termflow: offload-from=9.0.0 -->"), Offload),
        ("zero floor", "0.0.1", Some("<!-- termflow: offload-from=0.0.0 -->"), Offload),
    ]);
}

#[test]
fn a_running_build_that_is_not_a_version_is_never_full() {
    let far = Some("<!-- termflow: offload-from=99.0.0 -->");
    check(&[
        ("dev", "dev", far, Offload),
        ("empty", "", far, Offload),
        ("two fields", "1.2", far, Offload),
        ("leading v", "v1.2.3", far, Offload),
        ("four fields", "1.2.3.4", far, Offload),
        ("word", "unknown", far, Offload),
        ("leading zero", "01.2.3", far, Offload),
        ("surrounding space", " 1.2.3 ", far, Offload),
        ("empty pre-release", "1.2.3-", far, Offload),
        ("empty build", "1.2.3+", far, Offload),
        ("empty pre-release identifier", "1.2.3-beta..1", far, Offload),
        ("bad character in pre-release", "1.2.3-be_ta", far, Offload),
        ("version-like word", "1.2.x", far, Offload),
    ]);
}

#[test]
fn pre_release_and_build_metadata_on_the_running_build() {
    check(&[
        // A pre-release of the floor itself is older than the floor release.
        ("pre-release of the floor", "2.0.0-beta.1", Some("<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("pre-release of an older core", "1.9.9-rc.1", Some("<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("pre-release of a newer core", "2.0.1-beta.1", Some("<!-- termflow: offload-from=2.0.0 -->"), Offload),
        ("pre-release core far ahead", "3.0.0-alpha", Some("<!-- termflow: offload-from=2.0.0 -->"), Offload),
        ("release over its own floor", "2.0.0", Some("<!-- termflow: offload-from=2.0.0 -->"), Offload),
        // Build metadata never changes the order.
        ("build on the floor", "2.0.0+abc123", Some("<!-- termflow: offload-from=2.0.0 -->"), Offload),
        ("build on an older core", "1.9.9+abc123", Some("<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("pre-release and build on the floor", "2.0.0-beta.1+abc", Some("<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("hyphenated pre-release identifier", "2.0.1-rc-1", Some("<!-- termflow: offload-from=2.0.0 -->"), Offload),
    ]);
}

#[test]
fn the_marker_is_found_anywhere_in_the_notes() {
    check(&[
        ("first line", "1.0.0", Some("<!-- termflow: offload-from=2.0.0 -->\n## 2.0.0\n- fixes"), Full),
        ("after other text", "1.0.0", Some("## 2.0.0\n- fixes\n\n<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("last line, no trailing newline", "1.0.0", Some("## 2.0.0\n- a\n- b\n<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("inline in a sentence", "1.0.0", Some("Update from older builds <!-- termflow: offload-from=2.0.0 --> closes terminals."), Full),
        ("after another comment", "1.0.0", Some("<!-- build 7 -->\n<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("inside a markdown list", "1.0.0", Some("- item\n  <!-- termflow: offload-from=2.0.0 -->\n- item"), Full),
        ("only text", "1.0.0", Some("<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("floor met, mid-notes", "2.0.0", Some("## 2.0.0\n<!-- termflow: offload-from=2.0.0 -->\n- fixes"), Offload),
    ]);
}

#[test]
fn the_first_marker_wins_even_when_it_is_malformed() {
    check(&[
        ("both well-formed, first demands Full", "1.0.0",
            Some("<!-- termflow: offload-from=2.0.0 -->\n<!-- termflow: offload-from=0.5.0 -->"), Full),
        ("both well-formed, first allows Offload", "1.0.0",
            Some("<!-- termflow: offload-from=0.5.0 -->\n<!-- termflow: offload-from=2.0.0 -->"), Offload),
        ("first has a bad value, second would be Full", "1.0.0",
            Some("<!-- termflow: offload-from=v2 -->\n<!-- termflow: offload-from=2.0.0 -->"), Offload),
        ("first has an empty value, second would be Full", "1.0.0",
            Some("<!-- termflow: offload-from= -->\n<!-- termflow: offload-from=2.0.0 -->"), Offload),
        ("first has no '=', second would be Full", "1.0.0",
            Some("<!-- termflow: offload-from -->\n<!-- termflow: offload-from=2.0.0 -->"), Offload),
        ("first is a different comment, second is the marker", "1.0.0",
            Some("<!-- note -->\n<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("first is another termflow key, second is the marker", "1.0.0",
            Some("<!-- termflow: channel=beta -->\n<!-- termflow: offload-from=2.0.0 -->"), Full),
    ]);
}

#[test]
fn the_tag_and_the_key_are_case_insensitive_and_whitespace_is_not_significant() {
    check(&[
        ("canonical", "1.0.0", Some("<!-- termflow: offload-from=2.0.0 -->"), Full),
        ("upper-case key", "1.0.0", Some("<!-- termflow: OFFLOAD-FROM=2.0.0 -->"), Full),
        ("mixed-case key", "1.0.0", Some("<!-- termflow: Offload-From=2.0.0 -->"), Full),
        ("upper-case tag", "1.0.0", Some("<!-- TERMFLOW: offload-from=2.0.0 -->"), Full),
        ("no spaces at all", "1.0.0", Some("<!--termflow:offload-from=2.0.0-->"), Full),
        ("many spaces", "1.0.0", Some("<!--   termflow  :   offload-from   =   2.0.0   -->"), Full),
        ("tabs", "1.0.0", Some("<!--\ttermflow:\toffload-from\t=\t2.0.0\t-->"), Full),
        ("comment spread over lines", "1.0.0", Some("<!--\n  termflow: offload-from=2.0.0\n-->"), Full),
        ("floor met with odd spacing", "2.0.0", Some("<!--   TermFlow:   Offload-From = 2.0.0   -->"), Offload),
    ]);
}

#[test]
fn crlf_notes_are_read_like_lf_notes() {
    check(&[
        ("marker first, CRLF", "1.0.0", Some("<!-- termflow: offload-from=2.0.0 -->\r\n## 2.0.0\r\n- fixes\r\n"), Full),
        ("marker last, CRLF", "1.0.0", Some("## 2.0.0\r\n- fixes\r\n\r\n<!-- termflow: offload-from=2.0.0 -->\r\n"), Full),
        ("CR inside the comment", "1.0.0", Some("<!--\r\n termflow: offload-from=2.0.0\r\n-->\r\n"), Full),
        ("CRLF straight after the value", "1.0.0", Some("<!-- termflow: offload-from=2.0.0\r\n-->"), Full),
        ("CRLF notes, floor met", "2.0.0", Some("<!-- termflow: offload-from=2.0.0 -->\r\n- fixes\r\n"), Offload),
    ]);
}

#[test]
fn a_marker_in_a_fenced_code_block_still_counts() {
    // The reader does no Markdown parsing, so documented syntax in a fence is a
    // live marker. Pinned so a change to that is a decision, not an accident.
    check(&[
        ("fenced marker, floor ahead", "1.0.0",
            Some("Use:\n```\n<!-- termflow: offload-from=2.0.0 -->\n```\n"), Full),
        ("fenced marker, floor met", "2.0.0",
            Some("Use:\n```html\n<!-- termflow: offload-from=2.0.0 -->\n```\n"), Offload),
        ("fenced marker precedes a real one", "1.0.0",
            Some("```\n<!-- termflow: offload-from=0.1.0 -->\n```\n<!-- termflow: offload-from=2.0.0 -->"), Offload),
    ]);
}
