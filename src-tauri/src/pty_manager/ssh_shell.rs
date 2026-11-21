//! SSH-only prompt readiness; this module does not install a shell hook.
//!
//! Emit `ESC ] 633;TermFlowSshReady;<nonce>;<sequence> ST` (no spaces;
//! `ST` = `ESC \\`, or use BEL). The nonce is 32 lowercase hex digits, unique
//! to the registered process generation. Emit positive increasing decimal
//! sequence numbers, or for cmd PROMPT use `$E]633;TermFlowSshReady;<nonce>;$T$E\`
//! (24-hour `HH:MM:SS.hh`, including cmd's space-padded hour). Duplicates and
//! clock rollback/wrap fail closed. No hook takes a command or a secret.
//!
//! Stage the fresh process, generate a nonce with `new_nonce`, and register it
//! with `HostKeys::register_ssh_prompt` before starting its output reader. For a
//! hosted shell put the same nonce in the private SpawnSpec env entry
//! `termflow_pty_protocol::ssh_prompt::HOST_REGISTRATION_ENV`; the sidecar
//! consumes it as metadata, not as inherited shell environment. Do not register
//! reattached/replayed output. Neither source calls a writer or waits for one.

use super::input_gate::ReadyEpoch;
use crate::{elevated_host::HostChannel, state::HostKeys};
use termflow_pty_protocol::{da1::StartupDrain, ssh_prompt::PromptParser};

// Used by the shell adapters in the next checkpoint.
#[allow(dead_code)]
pub(crate) fn new_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(crate) enum PromptProof<'a> {
    Local { drain: &'a StartupDrain, input_generation: u64 },
    Hosted { channel: HostChannel, key: &'a str, epoch: u64, stdin_writes: u64 },
}

pub(super) fn filter_local_output(
    parser: &mut Option<PromptParser>,
    keys: &HostKeys,
    process: &str,
    drain: Option<&StartupDrain>,
    data: Vec<u8>,
    mut ready: impl FnMut(ReadyEpoch),
) -> Vec<u8> {
    let (Some(parser), Some(drain)) = (parser, drain) else { return data };
    let stamp = drain.is_drained().then(|| keys.ssh_prompt_input_generation(process)).flatten();
    parser.filter(data, stamp, |nonce, sequence, input_generation| {
        let proof = PromptProof::Local { drain, input_generation };
        if let Ok(epoch) = keys.observe_shell_prompt(process, nonce, sequence, proof) {
            ready(epoch);
        }
    })
}

#[cfg(test)]
#[path = "ssh_shell/tests.rs"]
mod tests;
