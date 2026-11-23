//! Typed rows emitted by the Windows PowerShell collector.
use super::{decimal, display, MountUsage, RawSample, Reading, Section, FIELD_LIMIT};
use crate::ssh::metrics::model::Users;
use chrono::{FixedOffset, NaiveDate, TimeZone};
use std::collections::{BTreeMap, BTreeSet};

const BAD: &str = "Invalid Windows metrics fields";
const WATCHDOG: &str = "Network drive usage watchdog expired";

pub(super) fn populate(sample: &mut RawSample<'_>) {
    let sections = &sample.sections;
    sample.hostname = metadata(&sections["hostname"]);
    sample.architecture = metadata(&sections["architecture"]);
    sample.os = fields(sections["winOs"].rows()).and_then(|fields| {
        let (caption, version) = (value(&fields, "caption")?, value(&fields, "version")?);
        Ok(display(&format!("{caption} {version}")))
    });
    sample.local = disks(sections["winDisks"].rows(), false);
    let drives = &sections["winNetDrives"];
    sample.nfs_watchdog_expired = matches!(drives.exit, 124 | 137);
    sample.nfs = if sample.nfs_watchdog_expired {
        Err(WATCHDOG)
    } else {
        disks(drives.rows(), true)
    };
}

// Encode/decode UTF-16 code units, not code points: astral characters arrive as two escapes.
fn unescape(s: &str) -> Reading<String> {
    if s.len() > FIELD_LIMIT {
        return Err(BAD);
    }
    let mut units = Vec::with_capacity(s.len());
    let mut bytes = s.as_bytes();
    while let Some((&first, rest)) = bytes.split_first() {
        match first {
            b'\\' => {
                let tail = rest.strip_prefix(b"u").ok_or(BAD)?;
                let digits = tail.get(..4).ok_or(BAD)?;
                if !digits.iter().all(u8::is_ascii_hexdigit) {
                    return Err(BAD);
                }
                let hex = std::str::from_utf8(digits).map_err(|_| BAD)?;
                units.push(u16::from_str_radix(hex, 16).map_err(|_| BAD)?);
                bytes = &tail[4..];
            }
            b' '..=b'~' => {
                units.push(u16::from(first));
                bytes = rest;
            }
            _ => return Err(BAD),
        }
    }
    let value = String::from_utf16(&units).map_err(|_| BAD)?;
    if value.len() > FIELD_LIMIT {
        return Err(BAD);
    }
    Ok(value)
}

fn metadata(section: &Section<'_>) -> Reading<String> {
    let [row] = section.rows()? else {
        return Err(BAD);
    };
    let name = display(unescape(row)?.trim());
    (!name.is_empty()).then_some(name).ok_or(BAD)
}

pub(in crate::ssh::metrics) fn fields<'a>(
    rows: Reading<&[&'a str]>,
) -> Reading<BTreeMap<&'a str, String>> {
    let mut fields = BTreeMap::new();
    for row in rows? {
        let (key, value) = row.split_once(' ').ok_or(BAD)?;
        if fields.insert(key, unescape(value)?).is_some() {
            return Err(BAD);
        }
    }
    Ok(fields)
}

pub(in crate::ssh::metrics) fn value<'a>(
    fields: &'a BTreeMap<&str, String>,
    key: &str,
) -> Reading<&'a str> {
    fields
        .get(key)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
        .ok_or(BAD)
}

pub(in crate::ssh::metrics) fn number<T: std::str::FromStr>(
    fields: &BTreeMap<&str, String>,
    key: &str,
) -> Reading<T> {
    decimal(value(fields, key)?).ok_or(BAD)
}

/// DMTF yyyymmddHHMMSS.ffffff±mmm, as UTC microseconds. Wildcards are not valid readings.
pub(in crate::ssh::metrics) fn dmtf(s: &str) -> Reading<i64> {
    if s.len() != 25 || !s.is_ascii() || s.as_bytes()[14] != b'.' {
        return Err(BAD);
    }
    let direction = match s.as_bytes()[21] {
        b'+' => 1,
        b'-' => -1,
        _ => return Err(BAD),
    };
    let offset =
        FixedOffset::east_opt(direction * decimal::<i32>(&s[22..]).ok_or(BAD)? * 60).ok_or(BAD)?;
    let date = NaiveDate::from_ymd_opt(
        decimal(&s[..4]).ok_or(BAD)?,
        decimal(&s[4..6]).ok_or(BAD)?,
        decimal(&s[6..8]).ok_or(BAD)?,
    )
    .filter(|_| &s[..4] != "0000")
    .ok_or(BAD)?;
    let time = date
        .and_hms_micro_opt(
            decimal(&s[8..10]).ok_or(BAD)?,
            decimal(&s[10..12]).ok_or(BAD)?,
            decimal(&s[12..14]).ok_or(BAD)?,
            decimal(&s[15..21]).ok_or(BAD)?,
        )
        .ok_or(BAD)?;
    Ok(offset
        .from_local_datetime(&time)
        .single()
        .ok_or(BAD)?
        .timestamp_micros())
}

pub(in crate::ssh::metrics) type PerfRows = BTreeMap<String, [u64; 3]>; // RX, TX, stamp (100 ns)

pub(in crate::ssh::metrics) fn perf_rows(rows: Reading<&[&str]>) -> Reading<PerfRows> {
    let mut counters = BTreeMap::new();
    for row in rows? {
        let decoded = unescape(row)?;
        let mut rest = decoded.as_str();
        let mut values = [0; 3];
        for value in &mut values {
            let (head, tail) = rest.split_once(' ').ok_or(BAD)?;
            *value = decimal(head).ok_or(BAD)?;
            rest = tail.trim_start_matches(' ');
        }
        if rest.is_empty()
            || rest.chars().any(char::is_control)
            || counters.insert(rest.into(), values).is_some()
        {
            return Err(BAD);
        }
    }
    Ok(counters)
}

pub(in crate::ssh::metrics) fn users(rows: Reading<&[&str]>) -> Reading<Users> {
    let mut count = 0;
    let mut names = BTreeSet::new();
    for row in rows?.iter().skip(1) {
        if let Some(name) = unescape(row)?.split_whitespace().next() {
            let name = display(name.trim_start_matches('>'));
            if !name.is_empty() {
                count += 1;
                names.insert(name);
            }
        }
    }
    Ok(Users {
        count,
        names: names.into_iter().collect(),
    })
}

fn disks(rows: Reading<&[&str]>, remote: bool) -> Reading<Vec<MountUsage>> {
    let mut disks = Vec::new();
    for row in rows? {
        let decoded = unescape(row)?;
        let mut parts = decoded.splitn(4, '\t');
        let (Some(drive), Some(size), Some(free), Some(detail)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(BAD);
        };
        if size.is_empty() {
            continue;
        }
        let total_bytes: u64 = decimal(size).filter(|&v| v != 0).ok_or(BAD)?;
        let available_bytes = decimal(free).ok_or(BAD)?;
        let used_bytes = total_bytes.checked_sub(available_bytes).ok_or(BAD)?;
        let [letter, b':'] = *drive.as_bytes() else {
            return Err(BAD);
        };
        if !letter.is_ascii_alphabetic() || detail.chars().any(char::is_control) {
            return Err(BAD);
        }
        disks.push(MountUsage {
            source: if remote {
                display(detail)
            } else {
                drive.into()
            },
            mount_point: drive.into(),
            fs_type: if remote {
                String::new()
            } else {
                display(detail)
            },
            total_bytes,
            available_bytes,
            used_bytes,
            used_percent: (u128::from(used_bytes) * 100).div_ceil(u128::from(total_bytes)) as u64,
        });
    }
    Ok(disks)
}

#[cfg(test)]
mod tests;
