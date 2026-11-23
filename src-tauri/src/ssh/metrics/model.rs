//! Renderer-facing metrics. Raw counter/baseline types stay in the reducer.
use serde::{Serialize, Serializer};

#[derive(Debug, PartialEq)]
pub enum Metric<T> {
    Available(T),
    Unavailable(String),
}

impl<T> From<Result<T, &'static str>> for Metric<T> {
    fn from(value: Result<T, &'static str>) -> Self {
        match value {
            Ok(value) => Self::Available(value),
            Err(reason) => Self::Unavailable(reason.into()),
        }
    }
}

impl<T: Serialize> Serialize for Metric<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Available<'a, T> {
            available: bool,
            #[serde(flatten)]
            value: &'a T,
        }
        #[derive(Serialize)]
        struct Unavailable<'a> {
            available: bool,
            reason: &'a str,
        }
        match self {
            Self::Available(value) => Available { available: true, value }.serialize(serializer),
            Self::Unavailable(reason) => Unavailable { available: false, reason }.serialize(serializer),
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub terminal_id: String,
    /// Unix milliseconds reserved by the sampler at collection start.
    pub sampled_at: u64,
    pub metrics: Metrics,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub host: Metric<Host>,
    pub cpu: Metric<Cpu>,
    pub ram: Metric<Ram>,
    pub net_up: Metric<Network>,
    pub net_down: Metric<Network>,
    pub uptime: Metric<Uptime>,
    pub users: Metric<Users>,
    pub partitions: Metric<Partitions>,
    pub nfs: Metric<Partitions>,
    /// Set only for a host whose platform has no collector (e.g. `macOS (Darwin)`): the bar says
    /// so instead of "Connected" over a row of n/a. Absent from the wire otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_platform: Option<String>,
    /// Set when nothing was measured: a whole-exec failure, or a parsed sample in which every
    /// metric is unavailable. The bar says "Metrics unavailable" instead of "Connected".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

impl Metrics {
    /// Marks a sample in which nothing was measured, whichever path built it. A named
    /// unsupported platform keeps its own status (D95), and one available metric is a measurement.
    pub fn flag_unmeasured(mut self) -> Self {
        if self.unavailable_reason.is_none() && self.unsupported_platform.is_none() {
            self.unavailable_reason = self.nothing_measured();
        }
        self
    }

    fn nothing_measured(&self) -> Option<String> {
        fn reason<T>(metric: &Metric<T>) -> Option<&str> {
            match metric {
                Metric::Available(_) => None,
                Metric::Unavailable(reason) => Some(reason),
            }
        }
        let reasons = [
            reason(&self.host), reason(&self.cpu), reason(&self.ram), reason(&self.net_up),
            reason(&self.net_down), reason(&self.uptime), reason(&self.users),
            reason(&self.partitions), reason(&self.nfs),
        ];
        // The CPU reason names the cause for the whole collector (e.g. the platform); Host's
        // names only the hostname section.
        reasons.iter().all(Option::is_some).then(|| reasons[1].unwrap_or_default().to_owned())
    }

    pub fn unavailable(reason: &str) -> Self {
        let mut metrics = Self::unsupported(reason, Metric::Unavailable(reason.into()), None);
        metrics.unavailable_reason = Some(reason.into());
        metrics
    }

    /// Every collected metric unavailable for `reason`; `host` is what the platform-neutral
    /// sections measured and `platform` names a platform without a collector.
    pub fn unsupported(reason: &str, host: Metric<Host>, platform: Option<String>) -> Self {
        Self {
            host,
            cpu: Metric::Unavailable(reason.into()),
            ram: Metric::Unavailable(reason.into()),
            net_up: Metric::Unavailable(reason.into()),
            net_down: Metric::Unavailable(reason.into()),
            uptime: Metric::Unavailable(reason.into()),
            users: Metric::Unavailable(reason.into()),
            partitions: Metric::Unavailable(reason.into()),
            nfs: Metric::Unavailable(reason.into()),
            unsupported_platform: platform,
            unavailable_reason: None,
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Host {
    pub hostname: String,
    pub os: Metric<Name>,
    pub architecture: Metric<Name>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Name {
    pub name: String,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Cpu {
    pub percent: Option<f64>,
    pub cores: Metric<Cores>,
    pub load1: Metric<Load>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Cores {
    pub count: u32,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Load {
    pub value: f64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ram {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub bytes_per_second: Option<f64>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Uptime {
    pub seconds: f64,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Users {
    pub count: usize,
    pub names: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Partitions {
    pub mounts: Vec<MountUsage>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountUsage {
    pub source: String,
    pub mount_point: String,
    pub fs_type: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub used_percent: u64,
}

#[cfg(test)]
mod tests;
