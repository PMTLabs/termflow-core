//! Reading the application's own source to prove a call is LIVE, not merely present.
//!
//! A text search finds a call in a comment, a string, an `if false` branch, a closure nobody
//! calls, or after the `return` that makes it unreachable. This module is the one machine under
//! every census that has to tell those apart (plan 055, T1/T3/T6):
//!
//! - [`Src`] masks comments, nested comments and the contents of ordinary, byte, raw and char
//!   literals before any boundary is located. Masked bytes become spaces, so offsets are preserved
//!   and the original text can still be read at any span (`code` keeps the string contents).
//! - [`Block`] / [`Stmt`] are a small statement tree built on the masked text by its own brace
//!   matcher: the statements of a function body, and under each statement the blocks and `match`
//!   arms it contains, each tagged with the construct it belongs to ([`Kind`]).
//! - A *subject* (a statement, or a span inside one) is *unconditional* in a block when no `if`,
//!   `else`, `match` arm, loop, closure or `async` block lies between it and that block; it is in
//!   an *arm* when the only conditional between it and the anchor is that named arm. "Before X"
//!   means before X's span. Only the returns that are statements of the selected block count: a
//!   `return` in a nested error branch does not make the continuation unreachable.
//!
//! Each caller states its subject and the context it requires; nothing here decides policy.
//! It is deliberately not [`super::source_scan`]: that one ends a block comment at the first `*/`
//! and has no notion of a statement.

use std::ops::Range;

/// A source file as the census reads it.
#[derive(Clone)]
pub(crate) struct Src {
    /// Comments blanked; string and char literals kept. Same byte offsets as the input.
    pub code: String,
    /// Comments blanked and literal contents blanked: the text every boundary is located on.
    pub masked: String,
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn blank(v: &mut [u8], range: Range<usize>) {
    for b in &mut v[range] {
        if *b != b'\n' {
            *b = b' ';
        }
    }
}

/// `(code, masked)` for `text`, which must already use `\n` line endings.
fn mask(text: &str) -> (String, String) {
    let b = text.as_bytes();
    let n = b.len();
    let mut code = b.to_vec();
    let mut masked = b.to_vec();
    let mut i = 0;
    while i < n {
        let c = b[i];
        if c == b'/' && b.get(i + 1) == Some(&b'/') {
            let end = text[i..].find('\n').map_or(n, |e| i + e);
            blank(&mut code, i..end);
            blank(&mut masked, i..end);
            i = end;
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            let mut depth = 1;
            let mut j = i + 2;
            while j < n && depth > 0 {
                if b[j] == b'/' && b.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else if b[j] == b'*' && b.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                } else {
                    j += 1;
                }
            }
            blank(&mut code, i..j);
            blank(&mut masked, i..j);
            i = j;
            continue;
        }
        // A string-like literal: `"..."`, `b"..."`, `r"..."`, `r#"..."#`, `br#"..."#`. The prefix
        // only counts at the start of a token, so `bar"` is not one.
        if (c == b'r' || c == b'b') && (i == 0 || !is_ident(b[i - 1])) {
            let mut k = i;
            if b[k] == b'b' {
                k += 1;
            }
            let raw = b.get(k) == Some(&b'r');
            if raw {
                k += 1;
            }
            let mut hashes = 0;
            while raw && b.get(k) == Some(&b'#') {
                hashes += 1;
                k += 1;
            }
            if b.get(k) == Some(&b'"') && (raw || k == i + 1) {
                i = literal(b, &mut masked, k, raw.then_some(hashes));
                continue;
            }
            if c == b'b' && b.get(i + 1) == Some(&b'\'') {
                i = char_literal(text, &mut masked, i + 1);
                continue;
            }
        }
        if c == b'"' {
            i = literal(b, &mut masked, i, None);
            continue;
        }
        if c == b'\'' {
            i = char_literal(text, &mut masked, i);
            continue;
        }
        i += 1;
    }
    (String::from_utf8(code).expect("masking keeps UTF-8"), String::from_utf8(masked).expect("masking keeps UTF-8"))
}

/// Blank the contents of the string whose opening quote is at `quote`; the index after it.
/// `raw` is the number of `#` of a raw string.
fn literal(b: &[u8], masked: &mut [u8], quote: usize, raw: Option<usize>) -> usize {
    let n = b.len();
    let mut j = quote + 1;
    match raw {
        Some(hashes) => {
            while j < n {
                if b[j] == b'"' && (0..hashes).all(|h| b.get(j + 1 + h) == Some(&b'#')) {
                    break;
                }
                j += 1;
            }
            blank(masked, quote + 1..j.min(n));
            (j + 1 + hashes).min(n)
        }
        None => {
            while j < n && b[j] != b'"' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            let end = j.min(n);
            blank(masked, quote + 1..end);
            (end + 1).min(n)
        }
    }
}

/// A `'` is a char literal (`'x'`, `'\n'`, `'\u{..}'`, `'é'`) or a lifetime (`'a`). Blank the
/// literal's contents; the index to continue from.
fn char_literal(text: &str, masked: &mut [u8], quote: usize) -> usize {
    let b = text.as_bytes();
    if b.get(quote + 1) == Some(&b'\\') {
        // The char after the backslash is escaped whatever it is (`'\''`); the literal ends at the
        // next quote after it (`'\u{1F600}'` is longer than one char).
        let Some(close) = text.get(quote + 3..).and_then(|rest| rest.find('\'')).map(|e| quote + 3 + e) else {
            return quote + 1;
        };
        blank(masked, quote + 1..close);
        return close + 1;
    }
    let Some(next) = text[quote + 1..].chars().next() else { return quote + 1 };
    let after = quote + 1 + next.len_utf8();
    if next != '\'' && b.get(after) == Some(&b'\'') {
        blank(masked, quote + 1..after);
        return after + 1;
    }
    quote + 1
}

/// Index of the delimiter closing the one at `open` (`(`, `[` or `{`), counting only that kind.
fn matching(m: &[u8], open: usize) -> usize {
    let (o, c) = match m[open] {
        b'(' => (b'(', b')'),
        b'[' => (b'[', b']'),
        b'{' => (b'{', b'}'),
        other => panic!("`{}` is not an opening delimiter", other as char),
    };
    let mut depth = 0usize;
    for (i, &ch) in m.iter().enumerate().skip(open) {
        if ch == o {
            depth += 1;
        } else if ch == c {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
    }
    panic!("unbalanced `{}` in a scanned source file", o as char);
}

fn skip_ws(m: &[u8], mut i: usize) -> usize {
    while i < m.len() && m[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// The end of the item that starts at `from`: the first top-level `;`, or the `}` closing the
/// first top-level `{`.
fn item_end(m: &[u8], from: usize) -> usize {
    let mut depth = 0i32;
    let mut i = from;
    while i < m.len() {
        match m[i] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b';' if depth == 0 => return i + 1,
            b'{' if depth == 0 => return matching(m, i) + 1,
            _ => {}
        }
        i += 1;
    }
    m.len()
}

/// What an enclosing block belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// A function body, a bare or `unsafe` block: transparent.
    Plain,
    /// A struct literal's braces (`Foo { a, b }`): an expression, so it holds no statements.
    Literal,
    If,
    Else,
    Loop,
    Closure,
    Async,
    /// One arm of a `match`; the arm's pattern.
    MatchArm(String),
    /// Not a block: the subject follows a statement of the same block that returns (or panics),
    /// so it never runs.
    AfterReturn,
}

impl Kind {
    pub fn is_conditional(&self) -> bool {
        !matches!(self, Kind::Plain | Kind::Literal)
    }
}

/// The statements of a `{ ... }`.
#[derive(Clone, Debug)]
pub(crate) struct Block {
    pub kind: Kind,
    pub open: usize,
    pub close: usize,
    pub stmts: Vec<Stmt>,
}

/// One statement: its span (the `;` included when there is one) and the constructs inside it.
#[derive(Clone, Debug)]
pub(crate) struct Stmt {
    pub span: Range<usize>,
    pub subs: Vec<Sub>,
    /// Brace-less closure bodies that are part of this statement, outside every sub-block.
    closures: Vec<Range<usize>>,
    /// The statement itself leaves the block (`return ..`, `panic!(..)` and the like), so nothing
    /// after it in the same block runs.
    pub diverges: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum Sub {
    Block(Block),
    Match { span: Range<usize>, arms: Vec<Arm> },
}

#[derive(Clone, Debug)]
pub(crate) struct Arm {
    pub pattern: String,
    pub body: Range<usize>,
    /// The arm's statements when its body is a `{ ... }`.
    pub block: Option<Block>,
}

impl Sub {
    fn span(&self) -> Range<usize> {
        match self {
            Sub::Block(b) => b.open..b.close + 1,
            Sub::Match { span, .. } => span.clone(),
        }
    }
}

impl Block {
    /// Index of the top-level statement of this block that contains `at`.
    pub fn top_index(&self, at: usize) -> Option<usize> {
        self.stmts.iter().position(|s| s.span.contains(&at))
    }

    /// Every construct between this block and `at`, outermost first (empty: `at` is a plain part
    /// of a top-level statement).
    pub fn constructs_at(&self, at: usize) -> Vec<Kind> {
        let mut out = Vec::new();
        let Some(index) = self.top_index(at) else { return out };
        // A statement after this block's own `return` never runs: that is as conditional as an
        // `if false`. A `return` nested in an earlier statement's branch does not count.
        if self.stmts[..index].iter().any(|s| s.diverges) {
            out.push(Kind::AfterReturn);
        }
        let stmt = &self.stmts[index];
        for sub in &stmt.subs {
            if !sub.span().contains(&at) {
                continue;
            }
            match sub {
                Sub::Block(b) => {
                    out.push(b.kind.clone());
                    out.extend(b.constructs_at(at));
                }
                Sub::Match { arms, .. } => {
                    if let Some(arm) = arms.iter().find(|a| a.body.contains(&at)) {
                        out.push(Kind::MatchArm(arm.pattern.clone()));
                        if let Some(block) = &arm.block {
                            out.extend(block.constructs_at(at));
                        }
                    }
                }
            }
        }
        for closure in &stmt.closures {
            if closure.contains(&at) {
                out.push(Kind::Closure);
            }
        }
        out
    }

    /// Whether `range` sits in a top-level statement of this block with no conditional construct
    /// in between.
    pub fn is_unconditional(&self, range: &Range<usize>) -> bool {
        self.top_index(range.start).is_some() && !self.constructs_at(range.start).iter().any(Kind::is_conditional)
    }

    /// Every statement of this block and, recursively, of every block and arm inside it.
    pub fn all_stmts(&self) -> Vec<&Stmt> {
        let mut out = Vec::new();
        for stmt in &self.stmts {
            out.push(stmt);
            for sub in &stmt.subs {
                match sub {
                    Sub::Block(b) => out.extend(b.all_stmts()),
                    Sub::Match { arms, .. } => {
                        for arm in arms {
                            if let Some(block) = &arm.block {
                                out.extend(block.all_stmts());
                            }
                        }
                    }
                }
            }
        }
        out
    }

    /// The innermost statement, at any depth, that contains `at`.
    pub fn deepest_stmt(&self, at: usize) -> Option<&Stmt> {
        let stmt = self.stmts.iter().find(|s| s.span.contains(&at))?;
        for sub in &stmt.subs {
            if !sub.span().contains(&at) {
                continue;
            }
            match sub {
                Sub::Block(b) => {
                    if let Some(inner) = b.deepest_stmt(at) {
                        return Some(inner);
                    }
                }
                Sub::Match { arms, .. } => {
                    for arm in arms.iter().filter(|a| a.body.contains(&at)) {
                        if let Some(inner) = arm.block.as_ref().and_then(|b| b.deepest_stmt(at)) {
                            return Some(inner);
                        }
                    }
                }
            }
        }
        Some(stmt)
    }

}

impl Src {
    /// `text` (any line ending) masked.
    pub fn new(text: &str) -> Src {
        let (code, masked) = mask(&text.replace("\r\n", "\n"));
        Src { code, masked }
    }

    /// Production text only: items behind a `#[cfg(test)]` (or `all(test, ..)`) are blanked.
    pub fn production(text: &str) -> Src {
        let src = Src::new(text);
        let m = src.masked.clone().into_bytes();
        let mut ranges = Vec::new();
        let mut from = 0;
        while let Some(rel) = src.masked[from..].find("#[cfg(") {
            let attr = from + rel;
            let attr_end = matching(&m, attr + 1) + 1;
            let attribute = &src.masked[attr..attr_end];
            from = attr_end;
            let is_test = words(attribute).any(|w| w == "test") && !attribute.contains("not(");
            if !is_test {
                continue;
            }
            let end = item_end(&m, skip_ws(&m, attr_end));
            ranges.push(attr..end);
            from = end;
        }
        let (mut code, mut masked) = (src.code.into_bytes(), src.masked.into_bytes());
        for range in ranges {
            blank(&mut code, range.clone());
            blank(&mut masked, range);
        }
        Src { code: String::from_utf8(code).unwrap(), masked: String::from_utf8(masked).unwrap() }
    }

    /// The text of `range` with every whitespace removed, strings included, comments gone.
    pub fn norm(&self, range: &Range<usize>) -> String {
        self.code[range.clone()].chars().filter(|c| !c.is_whitespace()).collect()
    }

    /// The body of the function whose text starts with `signature` (once in the file). A census
    /// that cannot find what it guards must not pass: panics when it is gone.
    pub fn function(&self, signature: &str) -> Block {
        self.try_function(signature).unwrap_or_else(|e| panic!("{e}"))
    }

    /// [`Self::function`] for a census whose own verdict is "that function is gone or changed".
    pub fn try_function(&self, signature: &str) -> Result<Block, String> {
        let mut hits = self.masked.match_indices(signature);
        let (start, _) = hits.next().ok_or_else(|| format!("`{signature}` not found"))?;
        if hits.next().is_some() {
            return Err(format!("`{signature}` is ambiguous"));
        }
        let m = self.masked.as_bytes();
        let mut depth = 0i32;
        let mut i = start + signature.len();
        let open = loop {
            match m.get(i).copied() {
                Some(b'(' | b'[') => depth += 1,
                Some(b')' | b']') => depth -= 1,
                Some(b'{') if depth <= 0 => break i,
                Some(b';') if depth <= 0 => return Err(format!("`{signature}` has no body")),
                None => return Err(format!("`{signature}` has no body")),
                _ => {}
            }
            i += 1;
        };
        Ok(self.block(Kind::Plain, open))
    }

    fn block(&self, kind: Kind, open: usize) -> Block {
        let m = self.masked.as_bytes();
        let close = matching(m, open);
        let mut stmts = Vec::new();
        if kind == Kind::Literal {
            return Block { kind, open, close, stmts };
        }
        let mut i = open + 1;
        loop {
            i = skip_ws(m, i);
            if i >= close {
                break;
            }
            let stmt = self.stmt(i, close);
            i = stmt.span.end;
            stmts.push(stmt);
        }
        Block { kind, open, close, stmts }
    }

    fn stmt(&self, start: usize, limit: usize) -> Stmt {
        let m = self.masked.as_bytes();
        let mut i = start;
        let mut depth = 0i32;
        let mut subs = Vec::new();
        let end = loop {
            if i >= limit {
                break limit;
            }
            match m[i] {
                b'(' | b'[' => {
                    depth += 1;
                    i += 1;
                }
                b')' | b']' => {
                    depth -= 1;
                    i += 1;
                }
                b';' if depth <= 0 => break i + 1,
                b'{' => {
                    let head = self.head(start, i);
                    let (sub, close) = self.sub(&head, i);
                    subs.push(sub);
                    i = close + 1;
                    if depth <= 0 && block_statement_ends(m, i, limit) {
                        break i;
                    }
                }
                _ => i += 1,
            }
        };
        let span = start..end;
        let closures = self.closures(&span, &subs);
        let diverges = diverges(&self.masked[span.clone()]);
        Stmt { span, subs, closures, diverges }
    }

    /// The text just before the `{` at `open`, back to the nearest boundary of the construct it
    /// introduces (`;`, `{`, `}`, `,`, `=>`, or an unbalanced opening bracket).
    fn head(&self, floor: usize, open: usize) -> String {
        let m = self.masked.as_bytes();
        let mut depth = 0i32;
        let mut i = open;
        while i > floor {
            let c = m[i - 1];
            match c {
                b')' | b']' => depth += 1,
                b'(' | b'[' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                b';' | b'{' | b'}' | b',' if depth == 0 => break,
                b'>' if depth == 0 && i >= 2 && m[i - 2] == b'=' => break,
                _ => {}
            }
            i -= 1;
        }
        self.masked[i..open].to_string()
    }

    fn sub(&self, head: &str, open: usize) -> (Sub, usize) {
        let m = self.masked.as_bytes();
        let kind = classify(head);
        if let Some(kind) = kind {
            return match kind {
                Classified::Match => {
                    let close = matching(m, open);
                    (Sub::Match { span: open..close + 1, arms: self.arms(open, close) }, close)
                }
                Classified::Kind(k) => {
                    let block = self.block(k, open);
                    let close = block.close;
                    (Sub::Block(block), close)
                }
            };
        }
        // No keyword introduces it: a bare block has no head, a struct literal is named by a path.
        let kind = if head.trim().is_empty() { Kind::Plain } else { Kind::Literal };
        let block = self.block(kind, open);
        let close = block.close;
        (Sub::Block(block), close)
    }

    fn arms(&self, open: usize, close: usize) -> Vec<Arm> {
        let m = self.masked.as_bytes();
        let mut arms = Vec::new();
        let mut i = open + 1;
        loop {
            while i < close && (m[i].is_ascii_whitespace() || m[i] == b',') {
                i += 1;
            }
            if i >= close {
                break;
            }
            let Some(arrow) = find_arrow(m, i, close) else { break };
            let pattern: String = self.masked[i..arrow].split_whitespace().collect::<Vec<_>>().join(" ");
            let body = skip_ws(m, arrow + 2);
            if m[body] == b'{' {
                let block = self.block(Kind::MatchArm(pattern.clone()), body);
                i = block.close + 1;
                arms.push(Arm { pattern, body: body..i, block: Some(block) });
            } else {
                let end = arm_expression_end(m, body, close);
                arms.push(Arm { pattern, body: body..end, block: None });
                i = end;
            }
        }
        arms
    }

    /// Brace-less closure bodies in `span`, outside the sub-blocks.
    fn closures(&self, span: &Range<usize>, subs: &[Sub]) -> Vec<Range<usize>> {
        let base = span.start;
        let mut flat = self.masked.as_bytes()[span.clone()].to_vec();
        for sub in subs {
            let r = sub.span();
            blank(&mut flat, r.start + 1 - base..r.end - 1 - base);
        }
        let n = flat.len();
        let mut out = Vec::new();
        let mut i = 0;
        while i < n {
            if flat[i] != b'|' {
                i += 1;
                continue;
            }
            // `a || b` and `a | b` are operators; a closure follows `(`, `,`, `=`, `move`, `=>`
            // or opens the statement.
            let mut p = i;
            while p > 0 && flat[p - 1].is_ascii_whitespace() {
                p -= 1;
            }
            let introducer = p == 0
                || matches!(flat[p - 1], b'(' | b',' | b'=' | b'>' | b'{' | b';')
                || flat[..p].ends_with(b"move")
                || flat[..p].ends_with(b"return");
            let double = flat.get(i + 1) == Some(&b'|');
            if !introducer {
                i += if double { 2 } else { 1 };
                continue;
            }
            // Params end at the next `|` (immediately for `||`).
            let params_end = if double {
                i + 2
            } else {
                flat[i + 1..].iter().position(|c| *c == b'|').map_or(n, |e| i + 1 + e + 1)
            };
            let body = skip_ws(&flat, params_end);
            if body >= n || flat[body] == b'{' {
                i = params_end;
                continue;
            }
            let mut depth = 0i32;
            let mut end = body;
            while end < n {
                match flat[end] {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => {
                        if depth == 0 {
                            break;
                        }
                        depth -= 1;
                    }
                    b',' | b';' if depth == 0 => break,
                    _ => {}
                }
                end += 1;
            }
            out.push(base + body..base + end);
            i = params_end;
        }
        out
    }
}

/// Whether a statement (masked text) unconditionally leaves its block: it starts with `return`,
/// or with a call that never returns.
fn diverges(statement: &str) -> bool {
    let text = statement.trim_start();
    let starts_word = |word: &str| text.strip_prefix(word).is_some_and(|rest| rest.chars().next().is_none_or(|c| !(c.is_alphanumeric() || c == '_')));
    starts_word("return")
        || ["panic!", "unreachable!", "todo!", "unimplemented!", "std::process::exit(", "process::exit("]
            .iter()
            .any(|prefix| text.starts_with(prefix))
}

/// Whether the statement that has just closed a `{ ... }` at `i` is over. `.`/`?`/`;`/`else`/`as`
/// continue it; anything else starts the next statement.
fn block_statement_ends(m: &[u8], i: usize, limit: usize) -> bool {
    let at = skip_ws(m, i);
    if at >= limit {
        return true;
    }
    match m[at] {
        b'.' | b'?' | b';' => false,
        _ => {
            let word: Vec<u8> = m[at..limit].iter().copied().take_while(|c| is_ident(*c)).collect();
            word != b"else" && word != b"as"
        }
    }
}

enum Classified {
    Match,
    Kind(Kind),
}

/// What kind of block the head text introduces; `None` is a plain block.
fn classify(head: &str) -> Option<Classified> {
    let trimmed = head.trim();
    if trimmed == "else" || trimmed.ends_with(" else") {
        return Some(Classified::Kind(Kind::Else));
    }
    let mut depth = 0i32;
    let mut word = String::new();
    let mut words: Vec<String> = Vec::new();
    for c in trimmed.chars().chain(std::iter::once(' ')) {
        if c.is_alphanumeric() || c == '_' {
            word.push(c);
            continue;
        }
        if !word.is_empty() {
            if depth == 0 {
                words.push(std::mem::take(&mut word));
            } else {
                word.clear();
            }
        }
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            _ => {}
        }
    }
    for w in &words {
        match w.as_str() {
            "if" => return Some(Classified::Kind(Kind::If)),
            "match" => return Some(Classified::Match),
            "while" | "for" | "loop" => return Some(Classified::Kind(Kind::Loop)),
            "async" => return Some(Classified::Kind(Kind::Async)),
            "unsafe" | "fn" => return Some(Classified::Kind(Kind::Plain)),
            _ => {}
        }
    }
    if trimmed.contains('|') {
        return Some(Classified::Kind(Kind::Closure));
    }
    None
}

/// The `=>` of the arm that starts at `from`, skipping balanced groups.
fn find_arrow(m: &[u8], from: usize, close: usize) -> Option<usize> {
    let mut i = from;
    while i < close {
        match m[i] {
            b'(' | b'[' | b'{' => i = matching(m, i),
            b'=' if m.get(i + 1) == Some(&b'>') => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}

/// The end of an arm whose body is an expression: the next top-level `,` or the match's end.
fn arm_expression_end(m: &[u8], from: usize, close: usize) -> usize {
    let mut i = from;
    while i < close {
        match m[i] {
            b'(' | b'[' | b'{' => i = matching(m, i),
            b',' => return i,
            _ => {}
        }
        i += 1;
    }
    close
}

/// A method chain: the receiver text and each `.name(args)` call at the chain's own depth.
pub(crate) struct Chain {
    /// The text before the first call, whitespace removed (`cmd` for `cmd.arg(..).envs(..)`).
    pub root: String,
    /// Each call's name and the span of what is between its parentheses.
    pub calls: Vec<(String, Range<usize>)>,
}

/// Split the statement at `span` into a [`Chain`]. Calls nested inside arguments are not part of it.
pub(crate) fn chain(src: &Src, span: &Range<usize>) -> Chain {
    let m = src.masked.as_bytes();
    let mut i = span.start;
    let mut root_end = None;
    let mut calls = Vec::new();
    while i < span.end {
        match m[i] {
            b'(' | b'[' | b'{' => {
                i = matching(m, i) + 1;
                continue;
            }
            b'.' => {
                let name_start = skip_ws(m, i + 1);
                let mut j = name_start;
                while j < span.end && is_ident(m[j]) {
                    j += 1;
                }
                let after = skip_ws(m, j);
                if j > name_start && m.get(after) == Some(&b'(') {
                    root_end.get_or_insert(i);
                    let close = matching(m, after);
                    calls.push((src.masked[name_start..j].to_string(), after + 1..close));
                    i = close + 1;
                    continue;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let root = src.norm(&(span.start..root_end.unwrap_or(span.end)));
    Chain { root, calls }
}

/// Index of the delimiter closing the one at `open` in the masked text.
pub(crate) fn find_close(src: &Src, open: usize) -> usize {
    matching(src.masked.as_bytes(), open)
}

/// Offsets of `word` in `masked[range]` as a whole word that is a variable use: not a method or
/// field name (`.env(` is not the variable `env`) and not a path segment.
pub(crate) fn word_uses(masked: &str, range: Range<usize>, word: &str) -> Vec<usize> {
    let b = masked.as_bytes();
    masked[range.clone()]
        .match_indices(word)
        .map(|(at, _)| range.start + at)
        .filter(|at| {
            // Not a method or field name (`.env(`), nor one segment of a path (`shell::process::X`).
            let before_ok = *at == 0 || !(is_ident(b[*at - 1]) || b[*at - 1] == b'.' || b[*at - 1] == b':');
            let after = *at + word.len();
            let after_ok = b.get(after).is_none_or(|c| !is_ident(*c)) && !masked[after..].starts_with("::");
            before_ok && after_ok
        })
        .collect()
}

impl Src {
    /// The span of the `{ ... }` that follows the first occurrence of `prefix` (a struct or impl
    /// header), braces included.
    pub fn braced_after(&self, prefix: &str) -> Range<usize> {
        let at = self.masked.find(prefix).unwrap_or_else(|| panic!("`{prefix}` not found"));
        let open = self.masked[at..].find('{').map(|i| at + i).expect("a braced item");
        open..matching(self.masked.as_bytes(), open) + 1
    }
}

/// The identifier-like words of `text`.
pub(crate) fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty())
}

/// Every offset where `needle` occurs in `masked` as a whole call/word start: not preceded by an
/// identifier character (so `apply(` does not match `reapply(`).
pub(crate) fn find_calls(masked: &str, needle: &str) -> Vec<usize> {
    masked
        .match_indices(needle)
        .map(|(at, _)| at)
        .filter(|at| *at == 0 || !is_ident(masked.as_bytes()[*at - 1]))
        .collect()
}

// ---- generic requirements ---------------------------------------------------------------------

/// Require `expected` (whitespace-insensitive) to be exactly one statement of the whole function
/// `body`, and that statement to be an unconditional top-level one. Returns its index in
/// `body.stmts`.
pub(crate) fn require_top_statement(src: &Src, body: &Block, expected: &str) -> Result<usize, String> {
    let want: String = expected.chars().filter(|c| !c.is_whitespace()).collect();
    let all = body.all_stmts().into_iter().filter(|s| src.norm(&s.span) == want).count();
    if all != 1 {
        return Err(format!("`{expected}` must appear as exactly one statement, found {all}"));
    }
    match body.stmts.iter().position(|s| src.norm(&s.span) == want) {
        Some(index) if body.is_unconditional(&body.stmts[index].span) => Ok(index),
        Some(_) => Err(format!("`{expected}` is not unconditional in the function body")),
        None => Err(format!("`{expected}` is nested in a conditional construct, not a top-level statement")),
    }
}

/// Index of the first top-level statement of `body` that starts with `prefix` (whitespace-free).
pub(crate) fn top_statement_starting(src: &Src, body: &Block, prefix: &str) -> Option<usize> {
    body.stmts.iter().position(|s| src.norm(&s.span).starts_with(prefix))
}

#[cfg(test)]
mod scanner_tests {
    use super::*;

    fn body_of(text: &str, signature: &str) -> (Src, Block) {
        let src = Src::new(text);
        let body = src.function(signature);
        (src, body)
    }

    fn texts(src: &Src, body: &Block) -> Vec<String> {
        body.stmts.iter().map(|s| src.norm(&s.span)).collect()
    }

    #[test]
    fn a_nested_block_comment_does_not_end_the_function() {
        let (src, body) = body_of(
            "fn f() { let a = 1; /* outer /* inner */ } still outer */ let b = 2; }\nfn g() { let c = 3; }",
            "fn f(",
        );
        assert_eq!(texts(&src, &body), ["leta=1;", "letb=2;"]);
    }

    #[test]
    fn braces_in_strings_chars_and_raw_strings_do_not_end_the_function() {
        let (src, body) = body_of(
            "fn f() { let a = \"}\"; let b = '}'; let c = r#\"}\"#; let d = b'}'; let e = b\"}\"; let g = r##\"\"# }\"##; let h = '\\''; let i: &'static str = \"\\\"}\"; }\nfn z() {}",
            "fn f(",
        );
        assert_eq!(body.stmts.len(), 8, "{:?}", texts(&src, &body));
        // the contents are masked for structure and kept for reading
        assert!(!src.masked.contains("\"}\""));
        assert!(src.code.contains("\"}\""));
    }

    #[test]
    fn a_comment_marker_inside_a_string_is_not_a_comment() {
        let (src, body) = body_of("fn f() { let a = \"// not a comment\"; let b = 2; }", "fn f(");
        assert_eq!(texts(&src, &body), ["leta=\"//notacomment\";", "letb=2;"]);
    }

    #[test]
    fn a_crlf_file_scans_the_same_as_an_lf_file() {
        let lf = "fn f() {\n    let a = 1; // c\n    if a == 1 {\n        g();\n    }\n    h();\n}\n";
        let crlf = lf.replace('\n', "\r\n");
        let (s1, b1) = body_of(lf, "fn f(");
        let (s2, b2) = body_of(&crlf, "fn f(");
        assert_eq!(texts(&s1, &b1), texts(&s2, &b2));
        assert_eq!(s1.masked, s2.masked);
    }

    #[test]
    fn a_statement_in_a_comment_or_string_is_not_a_statement() {
        let (src, body) = body_of(
            "fn f() { // hold.commit();\n /* hold.commit(); */ let s = \"hold.commit();\"; real(); }",
            "fn f(",
        );
        assert_eq!(texts(&src, &body), ["lets=\"hold.commit();\";", "real();"]);
        assert!(find_calls(&src.masked, "hold.commit(").is_empty());
    }

    #[test]
    fn conditional_constructs_are_told_apart_from_plain_ones() {
        let text = "fn f() {
            top();
            if false { in_if(); } else { in_else(); }
            for x in xs { in_loop(); }
            let v = match r { Ok(a) => in_arm_expr(a), Err(e) => { in_arm_block(); } };
            let c = || { in_closure(); };
            let d = |x| brace_less(x);
            let a = async { in_async(); };
            { in_bare(); }
            unsafe { in_unsafe(); }
            let p = Pair { x: 1 };
        }";
        let (src, body) = body_of(text, "fn f(");
        let at = |needle: &str| {
            let i = src.masked.find(needle).unwrap_or_else(|| panic!("{needle}"));
            i..i + needle.len()
        };
        let kinds = |needle: &str| body.constructs_at(at(needle).start);
        assert!(body.is_unconditional(&at("top();")));
        assert_eq!(kinds("in_if();"), [Kind::If]);
        assert_eq!(kinds("in_else();"), [Kind::Else]);
        assert_eq!(kinds("in_loop();"), [Kind::Loop]);
        assert_eq!(kinds("in_arm_expr(a)"), [Kind::MatchArm("Ok(a)".into())]);
        assert_eq!(kinds("in_arm_block();"), [Kind::MatchArm("Err(e)".into())]);
        assert_eq!(kinds("in_closure();"), [Kind::Closure]);
        assert_eq!(kinds("brace_less(x)"), [Kind::Closure]);
        assert_eq!(kinds("in_async();"), [Kind::Async]);
        assert!(body.is_unconditional(&at("in_bare();")));
        assert!(body.is_unconditional(&at("in_unsafe();")));
        assert!(body.is_unconditional(&at("let p = Pair { x: 1 };")));
        assert!(!body.is_unconditional(&at("in_if();")));
        assert!(!body.is_unconditional(&at("in_closure();")));
    }

    #[test]
    fn a_return_in_a_nested_branch_is_not_a_top_level_return() {
        let (src, body) = body_of("fn f() { if a { return 1; } work(); return 2; }", "fn f(");
        assert_eq!(texts(&src, &body), ["ifa{return1;}", "work();", "return2;"]);
        assert_eq!(top_statement_starting(&src, &body, "return"), Some(2));
    }

    #[test]
    fn a_statement_after_its_blocks_own_return_is_not_live() {
        let text = "fn f() { if a { return 1; } early(); return 2; late(); { inner(); } }\n\
                    fn g() { match x { Err(e) => { cleanup(); return Err(e); dead(); } Ok(v) => v } }\n\
                    fn h() { panic!(\"stop\"); after_panic(); }\n\
                    fn k() { let returned = 1; next(); }";
        let src = Src::new(text);
        let at = |needle: &str| src.masked.find(needle).unwrap();
        let f = src.function("fn f(");
        assert!(f.is_unconditional(&(at("early();")..at("early();") + 1)), "a nested return does not kill what follows");
        assert!(!f.is_unconditional(&(at("late();")..at("late();") + 1)));
        assert!(f.constructs_at(at("inner();")).contains(&Kind::AfterReturn), "nor anything nested after it");
        assert_eq!(require_top_statement(&src, &f, "late();").unwrap_err(), "`late();` is not unconditional in the function body");
        let g = src.function("fn g(");
        assert_eq!(g.constructs_at(at("cleanup();")), [Kind::MatchArm("Err(e)".into())]);
        assert_eq!(g.constructs_at(at("dead();")), [Kind::MatchArm("Err(e)".into()), Kind::AfterReturn]);
        let h = src.function("fn h(");
        assert!(!h.is_unconditional(&(at("after_panic();")..at("after_panic();") + 1)));
        let k = src.function("fn k(");
        assert!(k.is_unconditional(&(at("next();")..at("next();") + 1)), "`returned` is not `return`");
    }

    #[test]
    fn if_let_and_chained_blocks_are_single_statements() {
        let (src, body) = body_of(
            "fn f() { if let Err(e) = g().await { h(); return Err(e); } let x = if a { 1 } else { 2 }; k().await?; Ok(()) }",
            "fn f(",
        );
        assert_eq!(
            texts(&src, &body),
            ["ifletErr(e)=g().await{h();returnErr(e);}", "letx=ifa{1}else{2};", "k().await?;", "Ok(())"]
        );
    }

    #[test]
    fn attributes_for_test_code_are_blanked_in_production_text() {
        let text = "fn live() { a(); }\n#[cfg(test)]\nmod tests { fn t() { planted(); } }\n#[cfg(all(test, windows))]\nfn helper() { planted(); }\n#[cfg(not(test))]\nfn kept() { b(); }\n";
        let src = Src::production(text);
        assert!(!src.masked.contains("planted"));
        assert!(src.masked.contains("a();") && src.masked.contains("b();"));
        assert_eq!(src.masked.len(), text.len(), "offsets are preserved");
    }

    #[test]
    fn a_word_start_is_not_a_suffix_of_a_longer_name() {
        assert_eq!(find_calls("reapply(x); apply(y); a.apply(z);", "apply(").len(), 2);
    }
}
