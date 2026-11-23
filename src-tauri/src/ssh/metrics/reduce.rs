//! Pure reduction of one parsed sample and consecutive per-terminal baselines.
use super::model::*;
use super::protocol::{decimal, RawSample, Reading};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use uuid::Uuid;

const CPU_INVALID: &str = "Invalid CPU counters";
const CPU_STALLED: &str = "CPU counters did not advance";
const RAM_INVALID: &str = "Invalid memory counters";
const NET_INVALID: &str = "Invalid network counters";
const NET_ELAPSED: &str = "Remote uptime did not advance";

#[derive(Default)]
pub struct Reducer {
    boot: Boot,
    cpu: Option<[u64; 8]>,
    net: Option<Interfaces>,
}

#[derive(Default)]
struct Boot {
    id: Option<Uuid>,
    btime: Option<u64>,
    uptime: Option<Duration>,
}

type Interfaces = BTreeMap<String, [u64; 2]>; // RX, TX

impl Reducer {
    /// Clear baselines after a missed sample, pause, or session change (T3).
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// One instance per terminal/session. A completed watchdog run can retain
    /// instantaneous readings, but neither uses nor seeds a rate baseline.
    pub fn reduce(&mut self, raw: RawSample<'_>) -> Metrics {
        // Every platform's reading passes here, so a sample that measured nothing is marked once.
        self.reduce_platform(raw).flag_unmeasured()
    }

    fn reduce_platform(&mut self, raw: RawSample<'_>) -> Metrics {
        if let Some(reason) = raw.platform.unavailable_reason() {
            self.reset();
            let host = host(&raw);
            return Metrics::unsupported(&reason, host, raw.platform.unsupported_label());
        }
        let stat = rows(&raw, "stat");
        let uptime = rows(&raw, "uptime").and_then(parse_uptime);
        let boot = Boot {
            id: rows(&raw, "bootId").ok().and_then(|rows| match rows {
                [id] => Uuid::parse_str(id.trim()).ok(),
                _ => None,
            }),
            btime: stat.ok().and_then(|r| unique_value(r, "btime").ok().flatten()).and_then(decimal),
            uptime: uptime.ok(),
        };
        if raw.nfs_watchdog_expired || self.boot.changed(&boot) {
            self.reset();
        }
        let elapsed = boot.uptime.zip(self.boot.uptime).and_then(|(now, before)| now.checked_sub(before));
        let allow_wrap = elapsed.is_some_and(|d| !d.is_zero()) && self.boot.confirms_same_boot(&boot);

        let cpu = stat.and_then(cpu_counters).and_then(|now| {
            let before = self.cpu.replace(now);
            let percent = before.map_or(Ok(None), |before| cpu_percent(&before, &now, allow_wrap))?;
            Ok(Cpu { percent, cores: cores(&raw, stat), load1: load(&raw).into() })
        });
        if cpu.is_err() {
            self.cpu = None;
        }
        let net = uptime.and_then(|_| rows(&raw, "netdev")).and_then(interfaces).and_then(|now| {
            let before = self.net.replace(now);
            match before {
                Some(before) => network_rates(&before, self.net.as_ref().expect("just installed"), elapsed, allow_wrap),
                None => Ok([None, None]),
            }
        });
        if net.is_err() {
            self.net = None;
        }
        self.boot = boot;
        if raw.nfs_watchdog_expired {
            self.reset();
        }
        let ram = rows(&raw, "meminfo").and_then(memory).into();
        let users = rows(&raw, "who").and_then(users).into();
        Metrics {
            host: host(&raw),
            cpu: cpu.into(),
            ram,
            net_up: net.map(|rates| Network { bytes_per_second: rates[1] }).into(),
            net_down: net.map(|rates| Network { bytes_per_second: rates[0] }).into(),
            uptime: uptime.map(|duration| Uptime { seconds: duration.as_secs_f64() }).into(),
            users,
            partitions: raw.local.map(|mounts| Partitions { mounts }).into(),
            nfs: raw.nfs.map(|mounts| Partitions { mounts }).into(),
            unsupported_platform: None,
            unavailable_reason: None,
        }
    }
}

/// The Host metric from the platform-neutral sections (`uname -n`, `uname -m`, OS name), which
/// every platform's collector output carries.
fn host(raw: &RawSample<'_>) -> Metric<Host> {
    raw.hostname.clone().map(|hostname| Host {
        hostname,
        os: raw.os.clone().map(|name| Name { name }).into(),
        architecture: raw.architecture.clone().map(|name| Name { name }).into(),
    }).into()
}

impl Boot {
    fn changed(&self, now: &Self) -> bool {
        let rebooted = match self.id.zip(now.id) {
            // The boot id is authoritative. btime is the wall clock minus uptime, so a
            // stepped host clock (NTP, WSL2 host sync) moves it without any reboot.
            Some((a, b)) => a != b,
            None => self.btime.zip(now.btime).is_some_and(|(a, b)| a != b),
        };
        rebooted || self.uptime.zip(now.uptime).is_some_and(|(a, b)| b < a)
    }

    fn confirms_same_boot(&self, now: &Self) -> bool {
        if let Some((a, b)) = self.id.zip(now.id) {
            a == b
        } else {
            self.btime.zip(now.btime).is_some_and(|(a, b)| a == b)
        }
    }
}

fn rows<'a, 'b>(raw: &'a RawSample<'b>, key: &str) -> Reading<&'a [&'b str]> {
    raw.section(key).ok_or("Metrics section unavailable")?.rows()
}

fn unique_value<'a>(rows: &[&'a str], key: &str) -> Reading<Option<&'a str>> {
    let mut result = None;
    for row in rows {
        let Some(rest) = row.strip_prefix(key) else { continue };
        if (rest.is_empty() || rest.starts_with(|c: char| c.is_ascii_whitespace()))
            && result.replace(rest.trim_ascii()).is_some()
        {
            return Err("Duplicate metric field");
        }
    }
    Ok(result)
}

fn parse_uptime(rows: &[&str]) -> Reading<Duration> {
    const BAD: &str = "Invalid remote uptime";
    let [row] = rows else { return Err(BAD) };
    let value = row.split_ascii_whitespace().next().ok_or(BAD)?;
    let (secs, fraction) = match value.split_once('.') {
        Some((secs, fraction)) if (1..=9).contains(&fraction.len()) => {
            let nanos = decimal::<u32>(fraction).ok_or(BAD)?;
            (secs, nanos.checked_mul(10u32.pow(9 - fraction.len() as u32)).ok_or(BAD)?)
        }
        Some(_) => return Err(BAD),
        None => (value, 0),
    };
    Ok(Duration::new(decimal(secs).ok_or(BAD)?, fraction))
}

fn cpu_counters(stat: &[&str]) -> Reading<[u64; 8]> {
    let counters = unique_value(stat, "cpu")?.ok_or(CPU_INVALID)?;
    let mut values = [0; 8];
    let mut count = 0;
    for (index, value) in counters.split_ascii_whitespace().enumerate() {
        let counter = decimal(value).ok_or(CPU_INVALID)?;
        if let Some(slot) = values.get_mut(index) {
            *slot = counter;
        }
        count += 1;
    }
    // Original Linux fields: user, nice, system, idle. Later ABI fields
    // (iowait through steal) may be absent only as a trailing suffix.
    // guest/guest_nice are subsets of user/nice, not additional CPU time.
    if count < 4 { Err(CPU_INVALID) } else { Ok(values) }
}

fn delta(before: u64, now: u64, allow_wrap: bool) -> Option<u128> {
    let (before, now) = (u128::from(before), u128::from(now));
    let max = u128::from(u64::MAX);
    if now >= before {
        now.checked_sub(before)
    } else if allow_wrap && before * 4 > max * 3 && now * 4 < max {
        (1u128 << 64).checked_sub(before)?.checked_add(now)
    } else {
        None
    }
}

fn cpu_percent(before: &[u64; 8], now: &[u64; 8], allow_wrap: bool) -> Reading<Option<f64>> {
    let mut total = 0u128;
    let mut idle = 0u128;
    for index in 0..8 {
        // Linux explicitly allows iowait to decrease; do not infer a wrap.
        let Some(d) = delta(before[index], now[index], allow_wrap && index != 4) else {
            return Ok(None);
        };
        total = total.checked_add(d).ok_or(CPU_INVALID)?;
        if index == 3 || index == 4 {
            idle = idle.checked_add(d).ok_or(CPU_INVALID)?;
        }
    }
    if total == 0 {
        return Err(CPU_STALLED);
    }
    let busy = total.checked_sub(idle).ok_or(CPU_INVALID)?;
    Ok(Some(100.0 * (busy as f64 / total as f64)))
}

fn cores(raw: &RawSample<'_>, stat: Reading<&[&str]>) -> Metric<Cores> {
    let nproc = rows(raw, "nproc").ok().and_then(|rows| match rows {
        [line] => decimal::<u32>(line.trim_ascii()).filter(|&n| n != 0),
        _ => None,
    });
    let count = nproc.or_else(|| {
        let count = rows(raw, "cpuinfo").ok()?.iter().filter(|row| {
            row.split_once(':').is_some_and(|(key, _)| key.trim_ascii() == "processor")
        }).count();
        u32::try_from(count).ok().filter(|&n| n != 0)
    }).or_else(|| {
        let count = stat.ok()?.iter().filter(|row| {
            row.split_ascii_whitespace().next().and_then(|k| k.strip_prefix("cpu")).and_then(decimal::<u32>).is_some()
        }).count();
        u32::try_from(count).ok().filter(|&n| n != 0)
    });
    count.map(|count| Cores { count }).ok_or("CPU core count unavailable").into()
}

fn load(raw: &RawSample<'_>) -> Reading<Load> {
    const BAD: &str = "Invalid load average";
    let [line] = rows(raw, "loadavg")? else { return Err(BAD) };
    let s = line.split_ascii_whitespace().next().ok_or(BAD)?;
    if !s.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(BAD);
    }
    let value = s.parse::<f64>().map_err(|_| BAD)?;
    if !value.is_finite() {
        return Err(BAD);
    }
    Ok(Load { value })
}

fn memory(rows: &[&str]) -> Reading<Ram> {
    let kib = |key: &str| -> Reading<Option<u64>> {
        let mut value = None;
        for row in rows {
            let Some((field, rest)) = row.split_once(':') else { continue };
            if field != key { continue; }
            let mut cols = rest.split_ascii_whitespace();
            let n = cols.next().and_then(decimal).ok_or(RAM_INVALID)?;
            if cols.next() != Some("kB") || cols.next().is_some() || value.replace(n).is_some() {
                return Err(RAM_INVALID);
            }
        }
        Ok(value)
    };
    let required = |key| kib(key)?.ok_or(RAM_INVALID);
    let total = required("MemTotal")?;
    let total_bytes = total.checked_mul(1024).filter(|&n| n != 0).ok_or(RAM_INVALID)?;
    let available = match kib("MemAvailable")? {
        Some(value) => value,
        None => {
            let free = required("MemFree")?;
            let buffers = required("Buffers")?;
            let cached = required("Cached")?;
            let reclaimable = required("SReclaimable")?;
            let shmem = required("Shmem")?;
            let sum = free.checked_add(buffers).and_then(|n| n.checked_add(cached))
                .and_then(|n| n.checked_add(reclaimable)).ok_or(RAM_INVALID)?;
            sum.saturating_sub(shmem).min(total)
        }
    };
    let used_bytes = total.checked_sub(available).and_then(|n| n.checked_mul(1024)).ok_or(RAM_INVALID)?;
    Ok(Ram { used_bytes, total_bytes, percent: 100.0 * (used_bytes as f64 / total_bytes as f64) })
}

fn interfaces(rows: &[&str]) -> Reading<Interfaces> {
    let mut interfaces = BTreeMap::new();
    for row in rows {
        let row = row.trim_ascii();
        if row.starts_with("Inter-|") || row.starts_with("face |") { continue; }
        let (name, counters) = row.rsplit_once(':').ok_or(NET_INVALID)?;
        let name = name.trim_ascii();
        if name.is_empty() || name.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(NET_INVALID);
        }
        let mut cols = counters.split_ascii_whitespace();
        let mut pair = [0; 2];
        for index in 0..16 {
            let counter = cols.next().and_then(decimal).ok_or(NET_INVALID)?;
            match index {
                0 => pair[0] = counter,
                8 => pair[1] = counter,
                _ => (),
            }
        }
        if cols.next().is_some() || interfaces.insert(name.into(), pair).is_some() {
            return Err(NET_INVALID);
        }
    }
    if rows.is_empty() {
        return Err(NET_INVALID);
    }
    interfaces.remove("lo");
    Ok(interfaces)
}

fn network_rates(before: &Interfaces, now: &Interfaces, elapsed: Option<Duration>, wrap: bool) -> Reading<[Option<f64>; 2]> {
    let seconds = elapsed.filter(|d| !d.is_zero()).ok_or(NET_ELAPSED)?.as_secs_f64();
    if before.keys().ne(now.keys()) {
        return Ok([None, None]);
    }
    let rate = |direction: usize| {
        let total = before.values().zip(now.values()).try_fold(0u128, |sum, (a, b)| {
            sum.checked_add(delta(a[direction], b[direction], wrap)?)
        })?;
        let rate = total as f64 / seconds;
        rate.is_finite().then_some(rate)
    };
    Ok([rate(0), rate(1)])
}

fn users(rows: &[&str]) -> Reading<Users> {
    let mut names = BTreeSet::new();
    for row in rows {
        let name = row.split_ascii_whitespace().next().ok_or("Invalid user session record")?;
        if name.chars().any(char::is_control) {
            return Err("Invalid user session record");
        }
        names.insert(name.chars().take(256).collect::<String>());
    }
    Ok(Users { count: rows.len(), names: names.into_iter().collect() })
}

#[cfg(test)]
pub(super) mod tests;
