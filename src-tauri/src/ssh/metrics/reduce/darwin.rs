use super::*;
#[derive(Default)]
pub(super) struct Baseline;
pub(super) fn reduce(_: &mut Reducer, _: RawSample<'_>) -> Metrics { Metrics::unavailable("Darwin collector unavailable") }
