//! Darwin command formats. Framing and bounds are enforced by the parent.
use super::*;
pub(super) const SECTIONS: &[&str] = &["swVers", "ncpu", "memsize", "pagesize", "boottime", "now", "loadavg", "vmstat", "netstat", "iostat", "who", "mounts", "dfLocal", "dfNfs"];
pub(super) fn populate(sample: &mut RawSample<'_>) {
    let s = &sample.sections;
    sample.os = s["swVers"].rows().and_then(|rows| {
        let field = |key| rows.iter().find_map(|r| r.strip_prefix(key)).map(str::trim).filter(|s| !s.is_empty()).ok_or("Invalid sw_vers output");
        Ok(format!("{} {}", field("ProductName:")?, field("ProductVersion:")?))
    });
    let mounts = s["mounts"].rows().and_then(inventory);
    sample.local = s["dfLocal"].rows().and_then(|rows| partitions(rows, &mounts, false));
    sample.nfs_watchdog_expired = matches!(s["dfNfs"].exit, 124 | 137);
    sample.nfs = match s["dfNfs"].exit {
        124 | 137 => Err("NFS usage watchdog expired"),
        127 => Err("NFS usage requires timeout and df"),
        125 => Err("Safe NFS usage unavailable"),
        _ => s["dfNfs"].rows().and_then(|rows| partitions(rows, &mounts, true)),
    };
}
struct Mount { source: String, point: String, fs: String, kind: Fs }
fn inventory(rows: &[&str]) -> Reading<Vec<Mount>> {
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for row in rows {
        let (identity, flags) = row.rsplit_once(" (").ok_or(BAD_MOUNTS)?;
        let (source, point) = identity.split_once(" on ").ok_or(BAD_MOUNTS)?;
        let flags: Vec<_> = flags.strip_suffix(')').ok_or(BAD_MOUNTS)?.split(", ").collect();
        let fs = *flags.first().ok_or(BAD_MOUNTS)?;
        let kind = match fs {
            "nfs" => Fs::Nfs,
            "apfs" | "hfs" | "exfat" | "msdos" | "ufs" if flags.contains(&"local") && !flags.contains(&"nobrowse") => Fs::Local,
            "apfs" | "hfs" | "exfat" | "msdos" | "ufs" | "devfs" | "autofs" | "smbfs" | "afpfs" | "webdav" => Fs::Excluded,
            _ => Fs::Unknown,
        };
        let point = mount_text(point)?;
        if !point.starts_with('/') || !seen.insert(point.clone()) { return Err(BAD_MOUNTS); }
        out.push(Mount { source: mount_text(source)?, point, fs: fs.into(), kind });
    }
    Ok(out)
}
fn partitions(rows: &[&str], mounts: &Reading<Vec<Mount>>, nfs: bool) -> Reading<Vec<MountUsage>> {
    let mounts = mounts.as_ref().map_err(|e| *e)?;
    if mounts.iter().any(|m| m.kind == Fs::Unknown) { return Err(BAD_TYPE); }
    if !rows.is_empty() && !rows[0].starts_with("Filesystem") { return Err(BAD_DF); }
    if !rows.is_empty() && rows[0].split_ascii_whitespace().collect::<Vec<_>>() != ["Filesystem", "1024-blocks", "Used", "Available", "Capacity", "Mounted", "on"] { return Err(BAD_DF); }
    let mut usage = BTreeMap::new();
    for line in rows.iter().skip(1) {
        let row = df_row(line, false)?.ok_or(BAD_DF)?;
        if usage.insert(mount_text(row.source)?, row).is_some() { return Err(BAD_DF); }
    }
    mounts.iter().filter(|m| m.kind == if nfs { Fs::Nfs } else { Fs::Local }).map(|m| {
        let r = usage.get(&m.source).ok_or(BAD_DF)?;
        Ok(MountUsage { source: m.source.clone(), mount_point: m.point.clone(), fs_type: m.fs.clone(), total_bytes: r.total, used_bytes: r.used, available_bytes: r.available, used_percent: r.percent })
    }).collect()
}
