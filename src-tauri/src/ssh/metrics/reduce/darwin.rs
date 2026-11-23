//! Darwin rates use local monotonic exec-start elapsed time (plan 071 §10).
use super::*;
#[derive(Default)]
pub(super) struct Baseline {
    started: Option<std::time::Instant>,
    boot: Option<(u64, u64)>,
}
fn scalar(raw: &RawSample<'_>, key: &str) -> Reading<u64> {
    let [line] = rows(raw, key)? else { return Err("Invalid sysctl scalar") };
    decimal(line.trim()).ok_or("Invalid sysctl scalar")
}
fn boot(raw: &RawSample<'_>) -> Reading<(u64, u64)> {
    let [line] = rows(raw, "boottime")? else { return Err("Invalid boot time") };
    let body = line.strip_prefix("{ sec = ").and_then(|s| s.split_once(" }" )).map(|p| p.0).ok_or("Invalid boot time")?;
    let (sec, usec) = body.split_once(", usec = ").ok_or("Invalid boot time")?;
    Ok((decimal(sec).ok_or("Invalid boot time")?, decimal(usec).filter(|n: &u64| *n < 1_000_000).ok_or("Invalid boot time")?))
}
fn finite(s: &str) -> Reading<f64> {
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit() || c == b'.') { return Err("Invalid numeric field"); }
    s.parse::<f64>().ok().filter(|n| n.is_finite()).ok_or("Invalid numeric field")
}
fn cpu(raw: &RawSample<'_>) -> Reading<Cpu> {
    let mut position = None;
    let mut samples = Vec::new();
    for row in rows(raw, "iostat")? {
        let cols: Vec<_> = row.split_ascii_whitespace().collect();
        if let Some(i) = cols.iter().position(|c| *c == "us") {
            if cols.get(i + 1..i + 3) != Some(&["sy", "id"][..]) { return Err(CPU_INVALID); }
            position = Some(i);
        } else if let Some(i) = position {
            if cols.first().is_some_and(|s| s.bytes().all(|b| b.is_ascii_digit() || b == b'.')) {
                let values: Vec<_> = cols.get(i..i + 3).ok_or(CPU_INVALID)?.iter().map(|s| finite(s)).collect::<Reading<_>>()?;
                if values.iter().any(|v| *v > 100.0) || (values.iter().sum::<f64>() - 100.0).abs() > 2.0 { return Err(CPU_INVALID); }
                samples.push(values[2]);
            }
        }
    }
    if samples.len() < 2 { return Err(CPU_INVALID); }
    let cores = scalar(raw, "ncpu").and_then(|n| u32::try_from(n).ok().filter(|n| *n > 0).map(|count| Cores { count }).ok_or(CPU_INVALID)).into();
    let load1 = rows(raw, "loadavg").and_then(|r| {
        let [line] = r else { return Err("Invalid load average") };
        let body = line.strip_prefix("{ ").and_then(|s| s.strip_suffix(" }")).ok_or("Invalid load average")?;
        Ok(Load { value: finite(body.split_ascii_whitespace().next().ok_or("Invalid load average")?)? })
    }).into();
    Ok(Cpu { percent: Some(100.0 - samples[samples.len() - 1]), cores, load1 })
}
fn memory(raw: &RawSample<'_>) -> Reading<Ram> {
    let total = scalar(raw, "memsize")?.checked_add(0).filter(|n| *n > 0).ok_or(RAM_INVALID)?;
    let page = scalar(raw, "pagesize")?;
    let table = rows(raw, "vmstat")?;
    let header = table.first().and_then(|s| s.strip_prefix("Mach Virtual Memory Statistics: (page size of ")).and_then(|s| s.strip_suffix(" bytes)")).and_then(decimal::<u64>).ok_or(RAM_INVALID)?;
    if page == 0 || header != page { return Err(RAM_INVALID); }
    let field = |label| -> Reading<u64> {
        let matches: Vec<_> = table.iter().filter_map(|r| r.split_once(':')).filter(|(k, _)| *k == label).collect();
        let [(_, value)] = matches.as_slice() else { return Err(RAM_INVALID) };
        value.trim().strip_suffix('.').and_then(decimal).ok_or(RAM_INVALID)
    };
    let used = field("Pages active")?.checked_add(field("Pages wired down")?).and_then(|n| n.checked_add(field("Pages occupied by compressor").ok()?)).and_then(|n| n.checked_mul(page)).ok_or(RAM_INVALID)?.min(total);
    Ok(Ram { used_bytes: used, total_bytes: total, percent: used as f64 / total as f64 * 100.0 })
}
pub(super) fn interfaces(raw: &RawSample<'_>) -> Reading<Interfaces> {
    let table = rows(raw, "netstat")?;
    if !table.first().is_some_and(|s| s.starts_with("Name")) { return Err(NET_INVALID); }
    let mut out = Interfaces::new();
    for row in table.iter().skip(1) {
        let cols: Vec<_> = row.split_ascii_whitespace().collect();
        let name = *cols.first().ok_or(NET_INVALID)?;
        if name == "lo0" || name.ends_with('*') || !cols.get(2).is_some_and(|s| s.starts_with("<Link#") && s.ends_with('>')) { continue; }
        if !matches!(cols.len(), 10 | 11) { return Err(NET_INVALID); }
        // Address may be absent; the seven trailing counter columns are fixed.
        let counters = cols.get(cols.len().checked_sub(7).ok_or(NET_INVALID)?..).ok_or(NET_INVALID)?;
        let pair = [decimal(counters[2]).ok_or(NET_INVALID)?, decimal(counters[5]).ok_or(NET_INVALID)?];
        if out.insert(name.into(), pair).is_some() { return Err(NET_INVALID); }
    }
    Ok(out)
}
pub(super) fn reduce(reducer: &mut Reducer, raw: RawSample<'_>, started: std::time::Instant) -> Metrics {
    let boot = boot(&raw).ok();
    if raw.nfs_watchdog_expired || boot.is_none() || reducer.darwin.boot != boot { reducer.reset(); }
    let elapsed = reducer.darwin.started.and_then(|before| started.checked_duration_since(before));
    let net = interfaces(&raw).and_then(|now| {
        let before = reducer.net.replace(now);
        before.map_or(Ok([None, None]), |before| network_rates(&before, reducer.net.as_ref().expect("installed"), elapsed, boot.is_some()))
    });
    if net.is_err() { reducer.net = None; }
    reducer.darwin = Baseline { started: Some(started), boot };
    let result = Metrics {
        host: host(&raw), cpu: cpu(&raw).into(), ram: memory(&raw).into(),
        net_up: net.map(|v| Network { bytes_per_second: v[1] }).into(),
        net_down: net.map(|v| Network { bytes_per_second: v[0] }).into(),
        uptime: scalar(&raw, "now").and_then(|now| now.checked_sub(boot.ok_or("Invalid boot time")?.0).map(|seconds| Uptime { seconds: seconds as f64 }).ok_or("Invalid uptime")).into(),
        users: rows(&raw, "who").and_then(users).into(),
        partitions: raw.local.map(|mounts| Partitions { mounts }).into(), nfs: raw.nfs.map(|mounts| Partitions { mounts }).into(),
        platform: None, unsupported_platform: None, unavailable_reason: None,
    };
    if raw.nfs_watchdog_expired { reducer.reset(); }
    result
}
