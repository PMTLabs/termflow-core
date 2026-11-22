# SSH metrics renderer snapshots

`sshMetricsSnapshots.json` is a JSON array of two v1 sample event payloads (`SshMetricsSample`: `terminalId`, Unix-millisecond `sampledAt`, and `metrics` with nine tagged availability values). The first sample has null CPU/network rates; the second has measured rates. The times are deterministic test-clock readings, not host capture timestamps.

**Provenance:** Rust's synthetic Linux `Wire` fixture in `src-tauri/src/ssh/metrics/sampler/tests.rs` supplies framed stdout to the real collector over an in-memory SSH server. The sampler parses and reduces both readings and serializes them through its event sink. These are not real-host captures. `memory_server_emits_renderer_fixture_snapshots` compares the full emitted payloads against this file, and Jest reads them without running Rust.

To regenerate after an intentional protocol or schema change, run from `src-tauri`:

```sh
cargo test --lib generate_ssh_metrics_renderer_snapshots -- --ignored
cargo test --lib memory_server_emits_renderer_fixture_snapshots
```

Review the JSON diff and run `bun run test --runInBand --coverage=false sshMetricsFlow` from the repo root. Update literal renderer oracles only if the user-visible output intentionally changed.
