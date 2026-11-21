//! Byte framing shared by the two live PTY readers. Replay never goes through this parser.

pub const HOST_REGISTRATION_ENV: &str = "TERMFLOW_INTERNAL_SSH_PROMPT_NONCE";
const PREFIX: &[u8] = b"\x1b]633;TermFlowSshReady;";
const MAX_BODY: usize = 32 + 1 + 20;

pub fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 32 && nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub struct PromptParser {
    nonce: String,
    last_sequence: u64,
    pending: Vec<u8>,
    start: Option<u64>,
    consistent: bool,
}

impl PromptParser {
    pub fn new(nonce: String) -> Self {
        Self { nonce, last_sequence: 0, pending: Vec::new(), start: None, consistent: false }
    }

    /// `stamp` is live input provenance. Strip complete private OSCs even if
    /// stale, but only report one that stayed in the same live input generation.
    pub fn filter(
        &mut self,
        bytes: Vec<u8>,
        stamp: Option<u64>,
        mut observe: impl FnMut(&str, u64, u64),
    ) -> Vec<u8> {
        let mut visible = Vec::with_capacity(self.pending.len() + bytes.len());
        for byte in bytes {
            if !self.pending.is_empty() {
                self.consistent &= self.start == stamp;
                let len = self.pending.len();
                if len < PREFIX.len() && byte == PREFIX[len] {
                    self.pending.push(byte);
                    continue;
                }
                if len >= PREFIX.len() {
                    let st_pending = len > PREFIX.len() && self.pending[len - 1] == 0x1b;
                    if (st_pending && byte == b'\\') || (!st_pending && byte == 7) {
                        let end = if st_pending { len - 1 } else { len };
                        if let Some((nonce, sequence)) = parse_body(&self.pending[PREFIX.len()..end]) {
                            if nonce == self.nonce && sequence > self.last_sequence {
                                // Retire even a prompt seen while startup/write is in flight.
                                self.last_sequence = sequence;
                                if let (true, Some(start)) = (self.consistent, self.start) {
                                    observe(nonce, sequence, start);
                                }
                            }
                        }
                        self.pending.clear();
                        continue;
                    }
                    if !st_pending && (byte == 0x1b || (len < PREFIX.len() + MAX_BODY && (0x20..=0x7e).contains(&byte))) {
                        self.pending.push(byte);
                        continue;
                    }
                    if st_pending {
                        // The held ESC may instead start an adjacent OSC.
                        self.pending.pop();
                        visible.append(&mut self.pending);
                        if byte == PREFIX[1] {
                            self.pending.extend_from_slice(&PREFIX[..2]);
                            // Ambiguous suffix provenance: strip it, but don't publish it.
                            self.consistent = false;
                            continue;
                        }
                        visible.push(0x1b);
                    }
                }
                // A mismatch cannot hide the start of an adjacent OSC.
                visible.append(&mut self.pending);
            }
            if byte == PREFIX[0] {
                self.pending.push(byte);
                self.start = stamp;
                self.consistent = true;
            } else {
                visible.push(byte);
            }
        }
        visible
    }

    /// Preserve an incomplete candidate at EOF, just like an unrelated escape.
    pub fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.pending)
    }
}

fn parse_body(body: &[u8]) -> Option<(&str, u64)> {
    let (nonce, sequence) = std::str::from_utf8(body).ok()?.split_once(';')?;
    if !valid_nonce(nonce) {
        return None;
    }
    let sequence = if sequence.bytes().all(|b| b.is_ascii_digit()) {
        sequence.parse::<u64>().ok()?
    } else {
        // cmd PROMPT can supply $T without running a command. Treat its time
        // as an ordered sequence, never wrapping at midnight or on rollback.
        return parse_cmd_time(nonce, sequence.as_bytes());
    };
    Some((nonce, sequence))
}

fn parse_cmd_time<'a>(nonce: &'a str, time: &[u8]) -> Option<(&'a str, u64)> {
    if time.len() != 11 || time[2] != b':' || time[5] != b':' || time[8] != b'.' {
        return None;
    }
    let digit = |i: usize| time[i].is_ascii_digit().then(|| u64::from(time[i] - b'0'));
    let hour = if time[0] == b' ' { 0 } else { digit(0)? * 10 } + digit(1)?;
    let min = digit(3)? * 10 + digit(4)?;
    let sec = digit(6)? * 10 + digit(7)?;
    let fraction = digit(9)? * 10 + digit(10)?;
    (hour < 24 && min < 60 && sec < 60)
        .then_some((nonce, 1 + ((hour * 60 + min) * 60 + sec) * 100 + fraction))
}
