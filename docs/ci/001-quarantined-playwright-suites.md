# Quarantined Playwright suites (E2E + performance)

**Status:** quarantined (not running) · **Owner:** CI · **Follow-up:** rewrite for Tauri

## TL;DR

The Playwright **E2E** and **performance** suites in
`.github/workflows/e2e-tests.yml` are **disabled on purpose**. They were written
for the old **Electron** shell; the product is now **Tauri**, so they give no
signal. They stay in the workflow (documented, ready to rewrite) behind a single
flag. The **unit tests in the same workflow still run** and remain the real signal.

To re-enable after rewriting the suites for Tauri, flip one value:

```yaml
env:
  RUN_QUARANTINED_E2E: 'true'   # was 'false'
```

## Why they're quarantined

The Playwright config starts a `webServer` (the obsolete Electron launcher on port
3000) before the suite runs. On the current Tauri codebase that server build shells
out to the Rust backend, which produces two failure modes depending on where the job
lands:

- **On a runner with a Rust toolchain:** the backend **cold-compiles past the
  `webServer` timeout**, so the suite never gets a usable server — no signal, just a
  slow timeout.
- **On a runner without Rust** (any runner that hasn't installed the toolchain for
  this job): the build dies immediately with

  ```
  failed to run 'cargo metadata' command to get workspace directory:
  No such file or directory (os error 2)
  ```

Both were previously `continue-on-error: true`, so they never failed CI — but they
produced noisy red steps and misleading artifacts on every run. Quarantining removes
the noise without losing the scaffolding.

## How the gate works

Two mechanisms, because of a GitHub Actions context rule:

| Target | Gate | Why |
| --- | --- | --- |
| E2E **steps** (`Install Playwright Browsers`, `Run E2E tests`, artifact uploads) | `if: env.RUN_QUARANTINED_E2E == 'true'` | The `env` context **is** available in a step-level `if:` |
| `performance-tests` **job** (entirely obsolete) | `if: false` | The `env` context is **not** available in a job-level `if:` (only `github`, `needs`, `vars`, `inputs`), so a flag wouldn't evaluate there. Its original trigger is preserved in a comment. |

`continue-on-error: true` is kept on the E2E step so that when the flag is flipped on
during the rewrite, a still-flaky suite won't block CI while it's being stabilized.

## What still runs (do not gate these)

The `e2e-tests` job also runs the **real** signal, which must keep running regardless
of the flag:

- `Package unit tests (terminal-core)` — `bun run test:workspace`
- `Run unit tests` — `npm test`

## Re-enabling checklist (Tauri rewrite)

1. Rewrite the Playwright `webServer`/specs to drive the **Tauri** app instead of the
   Electron launcher (no port-3000 Electron server).
2. Add the Rust toolchain / platform WebView deps this job currently lacks
   (`e2e-tests` runs on GitHub-hosted `ubuntu-latest` and installs neither today,
   since the quarantined steps are the only thing that needs them).
3. Set `RUN_QUARANTINED_E2E: 'true'`.
4. Restore the `performance-tests` job trigger from the comment
   (`github.event_name == 'push' && github.ref == 'refs/heads/main'`) in place of
   `if: false`.
5. Watch a few runs; once green and giving signal, drop `continue-on-error`.

## Related

- `rust-tests.yml` runs Linux, Windows and macOS all on GitHub-hosted runners
  (`ubuntu-latest` / `windows-latest` / `macos-latest`), each installing its own
  Rust toolchain via `dtolnay/rust-toolchain`. That workflow is unaffected by
  this one's quarantine — it never touches the Playwright suites.
