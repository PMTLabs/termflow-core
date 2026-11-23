//! Windows CPU and network baselines share the collector's monotonic QPC uptime.
use super::host;
use crate::ssh::metrics::{
    model::*,
    protocol::{windows::*, RawSample},
};

const NO_LOAD: &str = "Load average is not available on Windows";
const BAD_RAM: &str = "Invalid memory counters";
const BAD_UPTIME: &str = "Invalid remote uptime";

#[derive(Default)]
pub(super) struct WindowsRates {
    clock: Option<(u64, u64)>, // uptime ticks, tick frequency
    cpu: Option<[u64; 3]>,     // idle, kernel (includes idle), user
    interfaces: Option<PerfRows>,
}

pub(super) fn reduce_windows(rates: &mut WindowsRates, raw: RawSample<'_>) -> Metrics {
    let section = |key| raw.section(key).expect("validated Windows section");
    let os = section("winOs");
    let os_data = os_fields(os);
    let fields_ref = os_data.as_ref().map_err(|&reason| reason);
    let os_error = |invalid| os_error(os, invalid);
    let clock = fields_ref.and_then(|f| {
        let ticks: u64 = number(f, "uptimeTicks").map_err(|_| os_error(BAD_UPTIME))?;
        let frequency: u64 = number(f, "tickFrequency").map_err(|_| os_error(BAD_UPTIME))?;
        if frequency == 0 {
            return Err(BAD_UPTIME);
        }
        Ok((ticks, frequency))
    });
    // A backwards uptime (or changed QPC frequency) invalidates both baselines.
    // Using remote monotonic uptime rather than wall time avoids treating NTP/time-zone
    // changes as a reboot. A missing clock also breaks continuity across samples.
    let elapsed = rates
        .clock
        .zip(clock.ok())
        .and_then(|((old, old_hz), (now, hz))| {
            (old_hz == hz).then_some(())?;
            let ticks = now.checked_sub(old)?;
            (ticks != 0).then(|| ticks as f64 / hz as f64)
        })
        .filter(|_| !raw.nfs_watchdog_expired);
    if elapsed.is_none() {
        *rates = WindowsRates::default();
    }
    rates.clock = clock.ok();
    let uptime = clock.map(|(ticks, hz)| Uptime {
        seconds: ticks as f64 / hz as f64,
    });
    let ram = fields_ref.and_then(|f| {
        let total_bytes: u64 = number(f, "totalBytes").map_err(|_| os_error(BAD_RAM))?;
        let avail = number(f, "availBytes").map_err(|_| os_error(BAD_RAM))?;
        let used_bytes = total_bytes
            .checked_sub(avail)
            .filter(|_| total_bytes != 0)
            .ok_or(BAD_RAM)?;
        Ok(Ram {
            used_bytes,
            total_bytes,
            percent: 100.0 * used_bytes as f64 / total_bytes as f64,
        })
    });
    let cpu = fields(section_rows(section("winCpu"))).and_then(|f| {
        clock?;
        let now = [
            number(&f, "idle100ns")?,
            number(&f, "kernel100ns")?,
            number(&f, "user100ns")?,
        ];
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
    let network = perf_rows(section_rows(section("winNet"))).and_then(|now| {
        clock?;
        let value = rates
            .interfaces
            .as_ref()
            .zip(elapsed)
            .and_then(|(before, seconds)| net_rates(before, &now, seconds));
        rates.interfaces = Some(now);
        Ok(value)
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
        users: users_section(section("winUsers")).into(),
        partitions: raw.local.map(|mounts| Partitions { mounts }).into(),
        nfs: raw.nfs.map(|mounts| Partitions { mounts }).into(),
    }
}

fn cpu_percent(
    [old_idle, old_kernel, old_user]: [u64; 3],
    [idle, kernel, user]: [u64; 3],
) -> Option<f64> {
    let idle = idle.checked_sub(old_idle)?;
    let total =
        u128::from(kernel.checked_sub(old_kernel)?) + u128::from(user.checked_sub(old_user)?);
    (total > 0 && u128::from(idle) <= total).then(|| 100.0 * (1.0 - idle as f64 / total as f64))
}

fn net_rates(before: &PerfRows, now: &PerfRows, seconds: f64) -> Option<[f64; 2]> {
    let mut rate = [0.0, 0.0];
    let mut has_common = false;
    for (name, &[rx, tx]) in now {
        let Some(&[old_rx, old_tx]) = before.get(name) else {
            continue;
        };
        has_common = true;
        rate[0] += rx.checked_sub(old_rx)? as f64 / seconds;
        rate[1] += tx.checked_sub(old_tx)? as f64 / seconds;
    }
    has_common.then_some(rate)
}

#[cfg(test)]
mod tests;
