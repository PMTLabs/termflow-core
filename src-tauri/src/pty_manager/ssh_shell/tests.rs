use super::*;
use crate::pty_manager::input_gate::{InputDispatch, LocalWriter, Refusal};
use crate::state::{CreateAdmission, CreateMode, ShellStage, StagedShell};
use std::sync::{Arc, Mutex};
use termflow_pty_protocol::da1::{StartupReplies, StartupReply, DA1_REPLY};

const LEAF: &str = "tm-ssh-prompt";
const PROCESS: &str = "pc-ssh-prompt";
const NONCE: &str = "0123456789abcdef0123456789abcdef";
const OLD_NONCE: &str = "fedcba9876543210fedcba9876543210";
const CWD: &[u8] = b"\x1b]9;9;C:\\work\x1b\\";

fn fixture() -> (HostKeys, u64) {
    let keys = HostKeys::default();
    let CreateAdmission::Run(generation) = keys.admit_create(LEAF, CreateMode::Mount).unwrap() else {
        panic!("expected fresh process");
    };
    keys.stage_shell(LEAF, generation, PROCESS, None).unwrap();
    (keys, generation)
}

fn register(keys: &HostKeys, generation: u64) -> Option<PromptParser> {
    keys.register_ssh_prompt(PROCESS, generation, NONCE).unwrap();
    keys.complete_shell(LEAF, generation, &StagedShell {
        process: PROCESS.into(), stage: ShellStage::Local,
    });
    keys.ssh_prompt_nonce(PROCESS).map(PromptParser::new)
}

fn marker(nonce: &str, sequence: &str) -> Vec<u8> {
    format!("\x1b]633;TermFlowSshReady;{nonce};{sequence}\x1b\\").into_bytes()
}

#[test]
fn ready_nonce_split_at_every_byte_boundary() {
    let marker = marker(NONCE, "1");
    let mut input = CWD.to_vec();
    input.extend_from_slice(&marker);
    input.extend_from_slice(b"PS> \x1b[0m");
    let visible_expected = [CWD, b"PS> \x1b[0m"].concat();
    for parts in (0..=input.len()).map(|i| vec![&input[..i], &input[i..]])
        .chain(std::iter::once(input.chunks(1).collect()))
    {
        let (keys, generation) = fixture();
        let mut parser = register(&keys, generation);
        let drain = StartupDrain::default();
        let mut ready = Vec::new();
        let mut visible = Vec::new();
        for part in parts {
            visible.extend(filter_local_output(&mut parser, &keys, PROCESS, Some(&drain), part.to_vec(), |epoch| ready.push(epoch)));
        }
        visible.extend(parser.as_mut().unwrap().finish());
        assert_eq!(visible, visible_expected);
        assert_eq!(ready.len(), 1);
        assert_eq!(crate::pty_manager::parse_osc_cwd(&visible).as_deref(), Some("C:\\work"));
    }
    // Procinfo strips argv, not PTY bytes. The existing exact prompt-integration
    // argv sequence still disappears from command matching, independently of OSC parsing.
    use crate::pty_manager::{command_line_for, spawn_spec::PS_CWD_INTEGRATION};
    let argv = ["pwsh", "-NoExit", "-Command", PS_CWD_INTEGRATION].map(str::to_string);
    assert_eq!(command_line_for(&argv, "pwsh"), "pwsh");

    // cmd PROMPT's $T is space-padded before 10 am and has no shell counter.
    let mut cmd = PromptParser::new(NONCE.into());
    let bytes = b"\x1b]633;TermFlowSshReady;0123456789abcdef0123456789abcdef; 9:12:33.04\x1b\\";
    let mut seen = Vec::new();
    assert!(cmd.filter(bytes.to_vec(), Some(0), |_, seq, _| seen.push(seq)).is_empty());
    assert_eq!(seen, [(1_u64 << 63) | (((9 * 60 + 12) * 60 + 33) * 100 + 4)]);
}

#[test]
fn wrong_nonce_old_generation_and_replayed_marker_are_ignored() {
    let (keys, generation) = fixture();
    assert_eq!(keys.register_ssh_prompt(PROCESS, generation.checked_sub(1).unwrap(), OLD_NONCE), Err(Refusal::StaleAttempt));
    let mut parser = register(&keys, generation);
    let writer: LocalWriter = Arc::new(Mutex::new(Box::new(std::io::sink())));
    let held = writer.lock().unwrap();
    let mut replies = StartupReplies::new(writer.clone(), "ssh-prompt-test".into());
    let drain = replies.drain();
    replies.send(StartupReply { bytes: DA1_REPLY, cursor: false, da1: true, consumed: 1 });
    assert!(!drain.is_drained());
    let feed = |parser: &mut Option<PromptParser>, bytes: Vec<u8>| {
        let mut ready = Vec::new();
        let visible = filter_local_output(parser, &keys, PROCESS, Some(&drain), bytes, |epoch| ready.push(epoch));
        assert!(visible.is_empty(), "private marker leaked");
        ready
    };
    assert!(feed(&mut parser, marker(NONCE, "1")).is_empty(), "pending startup reply");
    drop(held);
    drain.wait();

    for (label, bytes) in [
        ("wrong nonce", marker("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "99")),
        ("previous generation's nonce", marker(OLD_NONCE, "99")),
        ("startup marker replay", marker(NONCE, "1")),
    ] {
        assert!(feed(&mut parser, bytes).is_empty(), "{label}");
    }
    let stale = feed(&mut parser, marker(NONCE, "2")).pop().unwrap();
    let split = marker(NONCE, "3");
    assert!(feed(&mut parser, split[..split.len() - 1].to_vec()).is_empty());
    keys.admit_input(PROCESS, None, |_| Ok::<_, Refusal>(InputDispatch::Complete(()))).unwrap();
    assert!(feed(&mut parser, split[split.len() - 1..].to_vec()).is_empty(), "marker spanned admitted input");
    for (label, seq) in [("same sequence after input", "2"), ("split marker replay", "3")] {
        assert!(feed(&mut parser, marker(NONCE, seq)).is_empty(), "{label}");
    }
    let ticket = keys.prepare_ssh_input(PROCESS).unwrap();
    assert_eq!(keys.submit_ssh_input(&ticket, &stale, |_| Ok::<_, Refusal>(InputDispatch::Complete(()))), Err(Refusal::NotReady));
    let fresh = feed(&mut parser, marker(NONCE, "4"));
    assert_eq!(fresh.len(), 1);
    assert!(feed(&mut parser, marker(NONCE, "4")).is_empty());
    keys.submit_ssh_input(&ticket, &fresh[0], |_| Ok::<_, Refusal>(InputDispatch::Complete(()))).unwrap();
    assert_eq!(keys.submit_ssh_input(&ticket, &fresh[0], |_| Ok::<_, Refusal>(InputDispatch::Complete(()))), Err(Refusal::StaleAttempt));
}

#[test]
fn hosted_prompt_requires_current_pipe_and_matching_stdin_generation() {
    use crate::state::StageMode;
    let keys = HostKeys::default();
    let channel = HostChannel::Primary;
    let key = "ssh-fixture-host-key";
    let epoch = 5;
    keys.connect_fixture(channel, epoch);
    let CreateAdmission::Run(generation) = keys.admit_create(LEAF, CreateMode::Mount).unwrap() else {
        panic!("expected fresh process");
    };
    let (stage, _, _) = keys.stage_shell(LEAF, generation, PROCESS, Some((channel, key, StageMode::Spawn))).unwrap();
    let stage = stage.unwrap();
    assert!(keys.publish(&stage, PROCESS, epoch));
    keys.register_ssh_prompt(PROCESS, generation, NONCE).unwrap();
    let observed = |seq, pipe, stdin_writes| keys.observe_shell_prompt(PROCESS, NONCE, seq,
        PromptProof::Hosted { channel, key, epoch: pipe, stdin_writes });
    // The live first prompt can arrive before the spawn response.
    assert!(observed(1, epoch, 0).is_ok());
    keys.complete_shell(LEAF, generation, &StagedShell { process: PROCESS.into(), stage: ShellStage::Hosted(stage) });
    keys.admit_input(PROCESS, None, |_| Ok::<_, Refusal>(InputDispatch::Complete(()))).unwrap();
    assert!(matches!(observed(2, epoch, 0), Err(Refusal::NotReady)));
    assert!(matches!(observed(3, epoch - 1, 1), Err(Refusal::NotReady)));
    assert!(observed(4, epoch, 1).is_ok());
    assert!(matches!(observed(4, epoch, 1), Err(Refusal::StaleAttempt)));
}

#[test]
fn unregistered_terminal_output_is_byte_identical() {
    let (keys, _) = fixture();
    let private = marker(NONCE, "1");
    let chunks = [CWD, &private[..7], &private[7..], b"\xffordinary\x1b"];
    let mut parser = keys.ssh_prompt_nonce(PROCESS).map(PromptParser::new);
    for chunk in chunks {
        let output = filter_local_output(&mut parser, &keys, PROCESS, None, chunk.to_vec(), |_| panic!("ordinary terminal observed readiness"));
        assert_eq!(output, chunk);
    }
}

#[test]
fn cmd_time_marker_across_midnight_and_rollback_becomes_ready() {
    let (keys, generation) = fixture();
    let mut parser = register(&keys, generation);
    let drain = StartupDrain::default();
    for stamp in ["23:59:59.99", " 0:00:00.00", " 0:00:00.42", " 0:00:00.07"] {
        keys.admit_input(PROCESS, None, |_| Ok::<_, Refusal>(InputDispatch::Complete(()))).unwrap();
        let mut ready = None;
        let visible = filter_local_output(&mut parser, &keys, PROCESS, Some(&drain),
            marker(NONCE, stamp), |epoch| ready = Some(epoch));
        assert!(visible.is_empty());
        let ticket = keys.prepare_ssh_input(PROCESS).unwrap();
        keys.submit_ssh_input(&ticket, &ready.expect(stamp),
            |_| Ok::<_, Refusal>(InputDispatch::Complete(()))).unwrap();
    }
}

#[test]
fn cmd_duplicate_time_marker_is_ignored() {
    let (keys, generation) = fixture();
    let mut parser = register(&keys, generation);
    let drain = StartupDrain::default();
    let mut count = 0;
    let stamp = " 9:12:33.04";
    filter_local_output(&mut parser, &keys, PROCESS, Some(&drain), marker(NONCE, stamp), |_| count += 1);
    assert_eq!(count, 1);
    keys.admit_input(PROCESS, None, |_| Ok::<_, Refusal>(InputDispatch::Complete(()))).unwrap();
    // Independently exercise the gate as if another live source delivered the duplicate.
    let mut wire = PromptParser::new(NONCE.into());
    wire.filter(marker(NONCE, stamp), Some(0), |nonce, sequence, _| {
        assert!(matches!(keys.observe_shell_prompt(PROCESS, nonce, sequence,
            PromptProof::Local { drain: &drain,
                input_generation: keys.ssh_prompt_input_generation(PROCESS).unwrap() }),
            Err(Refusal::StaleAttempt)));
    });
    assert!(filter_local_output(&mut parser, &keys, PROCESS, Some(&drain), marker(NONCE, stamp),
        |_| panic!("same-centisecond marker created an epoch")).is_empty());
}
