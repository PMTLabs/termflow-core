//! Remote metrics collection, reduction, and per-terminal scheduling.
pub mod model;
pub mod protocol;
pub mod reduce;
pub mod sampler;

const COLLECT: &str = include_str!("metrics/collect.sh");
const UNAVAILABLE_EXIT: u32 = 125;

// The outer shell sees one fixed single-quoted awk program, inert tokens,
// and a portable OR-list. Construct quoting and backslashes only *inside*
// awk. A pure-sh decoder would need literal expansion or escape syntax in
// the wire command. Inside awk's POSIX shell, printf decodes bytes into a
// variable; the trailing X protects newlines and is removed before exec.
const DECODER: &str = concat!(
    r#"BEGIN {if (ARGC == 3 && substr(ARGV[1],1,1) == "x" && length(ARGV[1]) % 3 == 1 && "#,
    r#"(substr(ARGV[1],2) ~ /[^0-7]/) == 0 && length(ARGV[2]) == 32 && (ARGV[2] ~ /[^0-9a-f]/) == 0) {"#,
    r#"q=sprintf("%c",39); b=sprintf("%c",92); d=sprintf("%c",36); qq=sprintf("%c",34); data=""; "#,
    r#"for (i=2; i<=length(ARGV[1]); i+=3) {if (substr(ARGV[1],i,1) + 0 > 3) exit 1; data=data b "0" substr(ARGV[1],i,3)}; "#,
    r#"cmd="body=" d "(printf " q "%bX" q " " q data q ") || exit 1; exec sh -c " qq d "{body%X}" qq " termflow-metrics " ARGV[2]; "#,
    r#"exit (system(cmd) == 0 ? 0 : 1)}; exit 1}"#,
);

#[derive(Debug, PartialEq, Eq)]
pub enum CollectorError {
    Unavailable,
    Failed(u32),
}

/// Check the whole exec status before parsing stdout. Decoder failures (e.g.
/// missing awk) are not section failures and must not admit a partial sample.
pub fn check_collector_exit(exit: u32) -> Result<(), CollectorError> {
    match exit {
        0 => Ok(()),
        UNAVAILABLE_EXIT => Err(CollectorError::Unavailable),
        code => Err(CollectorError::Failed(code)),
    }
}

/// One command and its matching parser nonce; pass the command to one exec.
pub fn collector_command() -> (String, String) {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let command = encode(&nonce, COLLECT).expect("UUID generated as lowercase hex");
    (command, nonce)
}

fn encode(nonce: &str, script: &str) -> Option<String> {
    use std::fmt::Write;

    protocol::valid_nonce(nonce).then(|| {
        let mut payload = String::with_capacity(1 + 3 * script.len());
        payload.push('x'); // Prevent awk from treating a long numeric argument as a number.
        for byte in script.bytes() {
            write!(payload, "{byte:03o}").expect("writing to String cannot fail");
        }
        format!("awk '{DECODER}' {payload} {nonce} || /bin/sh -c 'exit {UNAVAILABLE_EXIT}'")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collector_command_is_login_shell_neutral() {
        let first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let second = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let command = encode(first, COLLECT).unwrap();
        assert_eq!(command, encode(second, COLLECT).unwrap().replace(second, first));
        assert_eq!(command.matches(first).count(), 1);
        // No whitespace other than space, no shell history/expansion/escape bytes.
        assert!(command.bytes().all(|b| b.is_ascii_graphic() || b == b' '));
        assert!(!command.bytes().any(|b| b"!\\$`".contains(&b)));
        let parts: Vec<_> = command.split('\'').collect();
        let ["awk ", decoder, args, "exit 125", ""] = parts.as_slice() else {
            panic!("expected exactly two fixed, inert quoted arguments");
        };
        assert_eq!(*decoder, DECODER);
        let payload = args.strip_prefix(' ').unwrap().strip_suffix(" || /bin/sh -c ").unwrap();
        let (encoded, nonce) = payload.split_once(' ').unwrap();
        let octal = encoded.strip_prefix('x').unwrap();
        assert_eq!(octal.len(), COLLECT.len() * 3);
        assert!(octal.bytes().all(|b| (b'0'..=b'7').contains(&b)));
        assert_eq!(nonce, first);
        let (production, nonce) = collector_command();
        assert_eq!(production, encode(&nonce, COLLECT).unwrap());
    }

    #[test]
    #[ignore = "prints a production exec command for the disposable-host capture runbook"]
    fn print_collector_command_for_capture() {
        let (command, _) = collector_command();
        println!("TERMFLOW_COLLECTOR_COMMAND={command}");
    }
}
