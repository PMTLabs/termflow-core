//! Windows rates use per-class timestamps; WMI classes do not share a clock origin.
use super::{host, rows};
use crate::ssh::metrics::{
    model::*,
    protocol::{windows::*, RawSample},
};

const TICKS_PER_SECOND: f64 = 10_000_000.0;
const MICROS_PER_SECOND: i64 = 1_000_000;
const NO_LOAD: &str = "Load average is not available on Windows";
const BAD_RAM: &str = "Invalid memory counters";
const BAD_UPTIME: &str = "Invalid remote uptime";

#[derive(Default)]
pub(super) struct WindowsRates {
    boot: Option<i64>,
    cpu: Option<(u64, u64)>,
    interfaces: Option<PerfRows>,
}

pub(super) fn reduce_windows(rates: &mut WindowsRates, raw: RawSample<'_>) -> Metrics {
    let os = fields(rows(&raw, "winOs"));
    let os_fields = os.as_ref().map_err(|&reason| reason);
    let boot_time = os_fields.and_then(|f| dmtf(value(f, "boot")?));
    let boot = boot_time
        .ok()
        .map(|time| time.div_euclid(MICROS_PER_SECOND));
    if raw.nfs_watchdog_expired || rates.boot != boot {
        *rates = WindowsRates::default();
    }
    rates.boot = boot;
    let uptime = os_fields.and_then(|f| {
        let now = dmtf(value(f, "now")?)?;
        let micros = now
            .checked_sub(boot_time?)
            .filter(|&v| v >= 0)
            .ok_or(BAD_UPTIME)?;
        Ok(Uptime {
            seconds: micros as f64 / MICROS_PER_SECOND as f64,
        })
    });
    let ram = os_fields.and_then(|f| {
        let total_kib: u64 = number(f, "totalKiB")?;
        let free_kib = number(f, "freeKiB")?;
        let used_kib = total_kib.checked_sub(free_kib).ok_or(BAD_RAM)?;
        let total_bytes = total_kib
            .checked_mul(1024)
            .filter(|&v| v != 0)
            .ok_or(BAD_RAM)?;
        Ok(Ram {
            used_bytes: used_kib * 1024,
            total_bytes,
            percent: 100.0 * used_kib as f64 / total_kib as f64,
        })
    });
    let cpu = fields(rows(&raw, "winCpu")).and_then(|f| {
        let now = (number(&f, "idle100ns")?, number(&f, "stamp100ns")?);
        let percent = rates
            .cpu
            .replace(now)
            .and_then(|before| cpu_percent(before, now));
        Ok(Cpu {
            percent,
            cores: number(&f, "cores")
                .and_then(|count| {
                    if count == 0 {
                        Err("Invalid CPU count")
                    } else {
                        Ok(Cores { count })
                    }
                })
                .into(),
            load1: Metric::Unavailable(NO_LOAD.into()),
        })
    });
    if cpu.is_err() {
        rates.cpu = None;
    }
    let network = perf_rows(rows(&raw, "winNet")).map(|now| {
        let value = rates
            .interfaces
            .as_ref()
            .and_then(|before| net_rates(before, &now));
        rates.interfaces = Some(now);
        value
    });
    if network.is_err() {
        rates.interfaces = None;
    }
    if raw.nfs_watchdog_expired {
        *rates = WindowsRates::default();
    }
    Metrics {
        platform: Some("Windows"),
        unsupported_platform: None,
        unavailable_reason: None,
        host: host(&raw),
        cpu: cpu.into(),
        ram: ram.into(),
        net_up: network
            .map(|r| Network {
                bytes_per_second: r.map(|r| r[1]),
            })
            .into(),
        net_down: network
            .map(|r| Network {
                bytes_per_second: r.map(|r| r[0]),
            })
            .into(),
        uptime: uptime.into(),
        users: users(rows(&raw, "winUsers")).into(),
        partitions: raw.local.map(|mounts| Partitions { mounts }).into(),
        nfs: raw.nfs.map(|mounts| Partitions { mounts }).into(),
    }
}

fn cpu_percent((idle_before, stamp_before): (u64, u64), (idle, stamp): (u64, u64)) -> Option<f64> {
    let idle_delta = idle.checked_sub(idle_before)?;
    let ticks = stamp.checked_sub(stamp_before)?;
    (ticks > 0 && idle_delta <= ticks).then(|| 100.0 - 100.0 * idle_delta as f64 / ticks as f64)
}

fn net_rates(before: &PerfRows, now: &PerfRows) -> Option<[f64; 2]> {
    if before.len() != now.len() {
        return None;
    }
    let mut rate = [0.0, 0.0];
    for (name, &[rx, tx, stamp]) in now {
        let &[old_rx, old_tx, old_stamp] = before.get(name)?;
        let ticks = stamp.checked_sub(old_stamp)?;
        if ticks == 0 {
            return None;
        }
        let seconds = ticks as f64 / TICKS_PER_SECOND;
        rate[0] += rx.checked_sub(old_rx)? as f64 / seconds;
        rate[1] += tx.checked_sub(old_tx)? as f64 / seconds;
    }
    Some(rate)
}

#[cfg(test)]
mod tests;
