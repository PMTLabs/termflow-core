//! Version-one framing and raw readings. No session state or rate calculation.
use std::collections::BTreeMap;

const FIELD_LIMIT: usize = 4096;
const ROW_LIMIT: usize = 4096;
const CAP: usize = 1024 * 1024;
const COMMON: &[&str] = &["platform", "hostname", "architecture"];
const LINUX: &[&str] = &[
    "stat", "meminfo", "netdev", "uptime", "bootId", "cpuinfo", "nproc", "loadavg", "who",
    "dfLocal", "dfNfs", "mounts", "osRelease",
];

pub type Reading<T> = Result<T, &'static str>;

#[derive(Debug, PartialEq, Eq)]
pub struct Section<'a> {
    pub exit: u8,
    rows: Reading<Vec<&'a str>>,
}

impl<'a> Section<'a> {
    pub fn rows(&self) -> Reading<&[&'a str]> {
        match self.exit {
            0 => self.rows.as_deref().map_err(|reason| *reason),
            126 => Err("Permission denied"),
            127 => Err("Required utility unavailable"),
            _ => Err("Collection command failed"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Unsupported(String),
    Unknown,
}

impl Platform {
    /// A shared reason for every metric when Linux collection is not supported.
    pub fn unavailable_reason(&self) -> Option<String> {
        match self {
            Self::Linux => None,
            Self::Unsupported(name) => Some(format!("Metrics are supported only on Linux ({name})")),
            Self::Unknown => Some("Remote platform unavailable".into()),
        }
    }
}

#[derive(Debug)]
pub struct RawSample<'a> {
    pub platform: Platform,
    pub hostname: Reading<String>,
    pub architecture: Reading<String>,
    pub os: Reading<String>,
    pub local: Reading<Vec<MountUsage>>,
    pub nfs: Reading<Vec<MountUsage>>,
    /// T3 feeds this into the indeterminate-remote-work latch.
    pub nfs_watchdog_expired: bool,
    sections: BTreeMap<&'static str, Section<'a>>,
}

impl<'a> RawSample<'a> {
    pub fn section(&self, key: &str) -> Option<&Section<'a>> {
        self.sections.get(key)
    }
}

pub(super) fn valid_nonce(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn parse<'a>(bytes: &'a [u8], nonce: &str) -> Reading<RawSample<'a>> {
    const FRAME: &str = "Invalid metrics framing";
    if !valid_nonce(nonce) || bytes.len() > CAP || bytes.contains(&0) {
        return Err(FRAME);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| FRAME)?;
    // split_inclusive lets us reject unterminated markers, not just missing markers.
    let section_prefix = format!("__TFM_{nonce}_SECTION_");
    let mut lines = text.split_inclusive('\n').map(|line| {
        line.strip_suffix('\n')
            .map(|s| (s.strip_suffix('\r').unwrap_or(s), true))
            .unwrap_or((line, false))
    });
    let prefix = format!("__TFM_{nonce}_");
    let begin = format!("{prefix}V1_BEGIN__");
    let end = format!("{prefix}V1_END__");
    loop {
        let (line, lf) = lines.next().ok_or(FRAME)?;
        if line == begin && lf {
            break;
        }
        if line.starts_with("__TFM_") {
            return Err(FRAME);
        }
    }
    let mut sections = BTreeMap::new();
    loop {
        let (line, lf) = lines.next().ok_or(FRAME)?;
        if !lf {
            return Err(FRAME);
        }
        if line == end {
            break;
        }
        let key = line
            .strip_prefix(section_prefix.as_str())
            .and_then(|s| s.strip_suffix("_BEGIN__"))
            .and_then(|s| COMMON.iter().chain(LINUX).copied().find(|key| *key == s))
            .ok_or(FRAME)?;
        let terminator = format!("{prefix}SECTION_{key}_END_");
        let mut rows = Vec::new();
        let exit = loop {
            let (line, lf) = lines.next().ok_or(FRAME)?;
            if !lf {
                return Err(FRAME);
            }
            if let Some(code) = line.strip_prefix(terminator.as_str()).and_then(|s| s.strip_suffix("__")) {
                break decimal::<u8>(code).ok_or(FRAME)?;
            }
            if line.starts_with("__TFM_") || line.contains(terminator.as_str()) {
                return Err(FRAME);
            }
            // One spare slot for the collector's separator blank line.
            if rows.len() <= ROW_LIMIT + 1 {
                rows.push(line);
            }
        };
        if rows.last() == Some(&"") {
            rows.pop();
        }
        let rows = if rows.len() > ROW_LIMIT || rows.iter().any(|s| !valid_field(s)) {
            Err("Metrics section contains invalid or oversized fields")
        } else {
            Ok(rows)
        };
        if sections.insert(key, Section { exit, rows }).is_some() {
            return Err(FRAME);
        }
    }
    if lines.any(|(line, _)| line.starts_with("__TFM_")) || COMMON.iter().any(|k| !sections.contains_key(k)) {
        return Err(FRAME);
    }
    let platform = match single(&sections["platform"]) {
        Ok(name) if name == "Linux" => Platform::Linux,
        Ok(name) => Platform::Unsupported(name),
        Err(_) => Platform::Unknown,
    };
    let linux = platform == Platform::Linux;
    if LINUX.iter().any(|key| sections.contains_key(key) != linux) {
        return Err(FRAME);
    }
    let mut sample = RawSample {
        platform,
        hostname: Err("Remote hostname unavailable"),
        architecture: Err("Remote architecture unavailable"),
        os: Err("Remote OS metadata unavailable"),
        local: Err("Linux partitions unavailable"),
        nfs: Err("Linux NFS partitions unavailable"),
        nfs_watchdog_expired: false,
        sections,
    };
    if linux {
        let s = &sample.sections;
        sample.hostname = single(&s["hostname"]);
        sample.architecture = single(&s["architecture"]);
        sample.os = os_release(s["osRelease"].rows());
        let mounts = s["mounts"].rows().and_then(mount_inventory);
        sample.local = s["dfLocal"].rows().and_then(|rows| df(rows, &mounts, false));
        sample.nfs_watchdog_expired = matches!(s["dfNfs"].exit, 124 | 137);
        sample.nfs = match s["dfNfs"].exit {
            124 | 137 => Err("NFS usage watchdog expired"),
            127 => Err("NFS usage requires timeout and df"),
            125 => Err("Safe NFS usage unavailable"),
            _ => s["dfNfs"].rows().and_then(|rows| df(rows, &mounts, true)),
        };
    }
    Ok(sample)
}

fn valid_field(s: &str) -> bool {
    s.len() <= FIELD_LIMIT && !s.chars().any(|c| c.is_control() && c != '\t')
}

fn single(section: &Section<'_>) -> Reading<String> {
    match section.rows()? {
        [name] if !name.trim().is_empty() => Ok(display(name.trim())),
        _ => Err("Remote metadata unavailable"),
    }
}

fn display(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(256).collect()
}

fn os_release(rows: Reading<&[&str]>) -> Reading<String> {
    const BAD: &str = "Remote OS metadata unavailable";
    let (mut name, mut version) = (None, None);
    for line in rows? {
        let slot = match line.split_once('=') {
            Some(("NAME", value)) => (&mut name, value),
            Some(("VERSION_ID", value)) => (&mut version, value),
            _ => continue,
        };
        if slot.0.replace(os_value(slot.1).ok_or(BAD)?).is_some() {
            return Err(BAD);
        }
    }
    let (name, version) = (name.ok_or(BAD)?, version.ok_or(BAD)?);
    Ok(display(&format!("{name} {version}")))
}

fn os_value(s: &str) -> Option<String> {
    let quote = s.chars().next()?;
    if quote == '\'' || quote == '"' {
        let body = s.strip_prefix(quote)?.strip_suffix(quote)?;
        let mut chars = body.chars();
        let mut value = String::new();
        while let Some(c) = chars.next() {
            if c == quote || c.is_control() {
                return None;
            }
            if c == '\\' && quote == '"' {
                let next = chars.next()?;
                if !matches!(next, '"' | '\\' | '$' | '`') {
                    value.push(c);
                }
                value.push(next);
            } else {
                value.push(c);
            }
        }
        (!value.trim().is_empty()).then_some(value)
    } else {
        s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)).then(|| s.into())
    }
}

fn decimal<T: std::str::FromStr>(s: &str) -> Option<T> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

#[derive(Debug, PartialEq, Eq)]
pub struct MountUsage {
    pub source: String,
    pub mount_point: String,
    pub fs_type: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub used_percent: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Fs {
    Local,
    Nfs,
    Excluded,
    Unknown,
}

fn fs_kind(fs: &str) -> Fs {
    match fs {
        "nfs" | "nfs4" => Fs::Nfs,
        "ext2" | "ext3" | "ext4" | "xfs" | "btrfs" | "zfs" | "overlay" | "f2fs"
        | "jfs" | "reiserfs" | "vfat" | "exfat" | "ntfs" | "ntfs3" | "bcachefs" | "erofs"
        | "squashfs" | "iso9660" | "udf" => Fs::Local,
        "tmpfs" | "devtmpfs" | "ramfs" | "proc" | "sysfs" | "cgroup" | "cgroup2" | "devpts"
        | "securityfs" | "debugfs" | "tracefs" | "pstore" | "mqueue" | "hugetlbfs" | "configfs"
        | "autofs" | "fusectl" | "binfmt_misc" | "bpf" | "nsfs" | "rpc_pipefs" | "selinuxfs"
        | "cifs" | "smb3" | "smbfs" | "sshfs" | "fuse.sshfs" | "9p" => Fs::Excluded,
        _ => Fs::Unknown,
    }
}

const BAD_DF: &str = "Invalid df output";
const BAD_MOUNTS: &str = "Mount inventory unavailable or ambiguous";
const BAD_TYPE: &str = "Filesystem type unavailable or ambiguous";

type Inventory<'a> = BTreeMap<(String, String), Option<&'a str>>;

fn mount_inventory<'a>(rows: &[&'a str]) -> Reading<Inventory<'a>> {
    let mut mounts = BTreeMap::new();
    for row in rows {
        let fields: Vec<_> = row.split_ascii_whitespace().collect();
        let [source, point, fs, _, _, _] = fields.as_slice() else {
            return Err(BAD_MOUNTS);
        };
        let key = (mount_text(source)?, mount_text(point)?);
        if !key.1.starts_with('/') {
            return Err(BAD_MOUNTS);
        }
        mounts.entry(key).and_modify(|ty| *ty = None).or_insert(Some(*fs));
    }
    Ok(mounts)
}

fn mount_text(s: &str) -> Reading<String> {
    // Kernel mount-table escapes, consumed once: a literal backslash must not
    // turn a following string of digits into another escape.
    let mut result = String::new();
    let mut rest = s;
    while let Some((prefix, suffix)) = rest.split_once('\\') {
        result.push_str(prefix);
        let (value, len) = match suffix.get(..3) {
            Some("040") => (' ', 3),
            Some("134") => ('\\', 3),
            Some("011" | "012" | "015") => return Err(BAD_DF),
            _ => ('\\', 0),
        };
        result.push(value);
        rest = &suffix[len..];
    }
    result.push_str(rest);
    if result.is_empty() || result.chars().any(char::is_control) {
        return Err(BAD_DF);
    }
    Ok(result)
}

fn df(rows: &[&str], inventory: &Reading<Inventory<'_>>, nfs: bool) -> Reading<Vec<MountUsage>> {
    let mut rows = rows.iter();
    let header = rows.next().copied();
    let typed = match header.map(|s| s.split_ascii_whitespace().collect::<Vec<_>>()).as_deref() {
        Some(["Filesystem", "Type", "1024-blocks" | "1K-blocks", "Used", "Available", "Capacity" | "Use%", "Mounted", "on"]) => true,
        Some(["Filesystem", "1024-blocks" | "1K-blocks", "Used", "Available", "Capacity" | "Use%", "Mounted", "on"]) => false,
        None if nfs => false, // successful proc inventory proved there was no NFS
        _ => return Err(BAD_DF),
    };
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    while let Some(line) = rows.next() {
        let joined;
        let row = match df_row(line, typed)? {
            Some(row) => row,
            None if !line.starts_with([' ', '\t']) && !line.is_empty() => {
                let continuation = rows.next().filter(|s| s.starts_with([' ', '\t'])).ok_or(BAD_DF)?;
                joined = format!("{line} {}", continuation.trim_start());
                df_row(&joined, typed)?.ok_or(BAD_DF)?
            }
            None => return Err(BAD_DF),
        };
        let key = (mount_text(row.source)?, mount_text(row.point)?);
        if !key.1.starts_with('/') || !seen.insert(key.clone()) {
            return Err(BAD_DF);
        }
        let reported = inventory.as_ref().ok().and_then(|mounts| mounts.get(&key));
        let fs = match (row.fs, reported) {
            (_, Some(None)) => return Err(BAD_TYPE),
            (Some(typed), Some(Some(actual))) if typed != *actual => return Err(BAD_TYPE),
            (_, Some(Some(actual))) => *actual,
            (Some(typed), None) if !nfs => typed,
            _ => return Err(if inventory.is_err() { BAD_MOUNTS } else { BAD_TYPE }),
        };
        match (nfs, fs_kind(fs)) {
            (false, Fs::Local) | (true, Fs::Nfs) => out.push(MountUsage {
                source: key.0,
                mount_point: key.1,
                fs_type: fs.into(),
                total_bytes: row.total,
                used_bytes: row.used,
                available_bytes: row.available,
                used_percent: row.percent,
            }),
            (false, Fs::Excluded | Fs::Nfs) => (),
            _ => return Err(BAD_TYPE),
        }
    }
    if nfs {
        let mounts = inventory.as_ref().map_err(|_| BAD_MOUNTS)?;
        // Don't fabricate an empty or partial NFS list if df didn't account
        // for an inventoried mount (e.g. hidden or duplicate mount records).
        if mounts.iter().any(|(key, ty)| match ty {
            Some(fs) => fs_kind(fs) == Fs::Nfs && !seen.contains(key),
            None => true,
        }) {
            return Err(BAD_MOUNTS);
        }
    }
    Ok(out)
}

struct DfRow<'a> {
    source: &'a str,
    fs: Option<&'a str>,
    point: &'a str,
    total: u64,
    used: u64,
    available: u64,
    percent: u64,
}

fn df_row(line: &str, typed: bool) -> Reading<Option<DfRow<'_>>> {
    if line.len() > FIELD_LIMIT {
        return Err(BAD_DF);
    }
    let start = line.as_ptr() as usize;
    let tokens: Vec<_> = line.split_ascii_whitespace().collect();
    let mut result = None;
    for (index, cols) in tokens.windows(5).enumerate().skip(if typed { 2 } else { 1 }) {
        let Some(percent) = cols[3].strip_suffix('%') else { continue };
        if !cols[4].starts_with('/') {
            continue;
        }
        let index_of = |s: &str| s.as_ptr() as usize - start;
        let kib = |s| decimal::<u64>(s).and_then(|n| n.checked_mul(1024)).ok_or(BAD_DF);
        let source_end = if typed { tokens[index - 1] } else { cols[0] };
        let row = DfRow {
            source: line[..index_of(source_end)].trim_end(),
            fs: typed.then(|| tokens[index - 1]),
            point: &line[index_of(cols[4])..],
            total: kib(cols[0])?,
            used: kib(cols[1])?,
            available: kib(cols[2])?,
            percent: decimal(percent).ok_or(BAD_DF)?,
        };
        if result.replace(row).is_some() {
            return Err(BAD_DF);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
