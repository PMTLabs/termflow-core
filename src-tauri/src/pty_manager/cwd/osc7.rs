//! Incremental remote OSC 7 decoder, separate from the legacy local cwd parser.

const PREFIX: &[u8] = b"]7;file://";
const MAX_URI_BYTES: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RemotePath {
    pub host: String,
    pub path: String,
}

#[derive(Clone, Copy, Default)]
enum State {
    #[default]
    Scan,
    Prefix(usize),
    Uri,
    Terminator,
}

#[derive(Default)]
pub(crate) struct Osc7 {
    state: State,
    uri: Vec<u8>,
}

impl Osc7 {
    pub fn reset(&mut self) {
        self.state = State::Scan;
        self.uri.clear();
    }

    pub fn feed(&mut self, bytes: &[u8], mut report: impl FnMut(RemotePath)) {
        for &byte in bytes {
            match self.state {
                State::Uri if byte == 7 => self.finish(&mut report),
                State::Uri if byte == 27 => self.state = State::Terminator,
                State::Terminator if byte == b'\\' => self.finish(&mut report),
                State::Uri if byte != 0 && self.uri.len() < MAX_URI_BYTES => {
                    self.uri.push(byte);
                }
                State::Prefix(n) if byte == PREFIX[n] => {
                    self.state = if n + 1 == PREFIX.len() {
                        State::Uri
                    } else {
                        State::Prefix(n + 1)
                    };
                }
                State::Terminator | State::Scan | State::Prefix(_) | State::Uri => {
                    // The ESC we held for ST may instead begin a fresh OSC.
                    let new_prefix = match (&self.state, byte) {
                        (_, 27) => Some(0),
                        (State::Terminator, b']') => Some(1),
                        _ => None,
                    };
                    self.reset();
                    if let Some(n) = new_prefix {
                        self.state = State::Prefix(n);
                    }
                }
            }
        }
    }

    fn finish(&mut self, report: &mut impl FnMut(RemotePath)) {
        let decoded = decode(&self.uri);
        self.reset();
        if let Some(path) = decoded {
            report(path);
        }
    }
}

fn decode(uri: &[u8]) -> Option<RemotePath> {
    let slash = uri.iter().position(|&b| b == b'/')?;
    let (host, mut raw) = uri.split_at(slash);
    let host = std::str::from_utf8(host).ok()?.to_owned();
    let mut path = Vec::with_capacity(raw.len());
    while let Some((&byte, rest)) = raw.split_first() {
        if byte == b'%' {
            let hi = hex(*rest.first()?)?;
            let lo = hex(*rest.get(1)?)?;
            path.push((hi << 4) | lo);
            raw = &rest[2..];
        } else {
            path.push(byte);
            raw = rest;
        }
    }
    if path.contains(&0) {
        return None;
    }
    Some(RemotePath { host, path: String::from_utf8(path).ok()? })
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_osc7_split_at_every_byte_decodes_posix_path_once() {
        for terminator in ["\x07", "\x1b\\"] {
            let sequence = format!("\x1b]7;file://SomeHost/C:/中/caf%C3%A9%2520{terminator}");
            for i in 0..=sequence.len() {
                let mut parser = Osc7::default();
                let mut out = Vec::new();
                let (a, b) = sequence.as_bytes().split_at(i);
                parser.feed(a, |p| out.push(p));
                parser.feed(b, |p| out.push(p));
                assert_eq!(out, [RemotePath {
                    host: "SomeHost".into(), path: "/C:/中/café%20".into(),
                }], "split {i}");
            }
        }
    }

    #[test]
    fn invalid_paths_are_ignored_but_empty_host_is_preserved() {
        let mut parser = Osc7::default();
        for bytes in [
            &b"\x1b]7;file://host\x07"[..],
            b"\x1b]7;file://host/%00\x07",
            b"\x1b]7;file://host/%ff\x07",
            b"\x1b]7;file://host/%a\x07",
            b"\x1b]7;file://host/%ax\x07",
            b"\x1b]7;file://host/\0x\x07",
        ] {
            parser.feed(bytes, |_| panic!("invalid OSC accepted"));
        }
        let mut out = Vec::new();
        parser.feed(b"\x1b]7;file:///path\x07", |p| out.push(p));
        assert_eq!(out, [RemotePath { host: String::new(), path: "/path".into() }]);
    }

    #[test]
    fn overlong_sequence_discards_at_the_cap_and_resyncs() {
        let mut parser = Osc7::default();
        parser.feed(b"\x1b]7;file://host/", |_| unreachable!());
        parser.feed(&[b'x'; MAX_URI_BYTES * 2], |_| unreachable!());
        assert!(parser.uri.capacity() <= MAX_URI_BYTES);
        assert!(parser.uri.is_empty());
        let mut out = Vec::new();
        parser.feed(b"ignored\x07\x1b]7;file://host/ok\x07", |p| out.push(p.path));
        assert_eq!(out, [String::from("/ok")]);
    }
}
