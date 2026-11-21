# SSH metrics: collector capture provenance

These are placeholders, not recordings. None were captured during T1.
The capture-based tests intentionally fail until all four are replaced and
their exact independent oracles are recorded in `../protocol/tests.rs`.

| Fixture | Disposable SSH target alias | OS/kernel/BusyBox provenance |
|---|---|---|
| `ubuntu.txt` | `tf-metrics-ubuntu` | PENDING CAPTURE (orchestrator, final pass) |
| `alpine.txt` | `tf-metrics-alpine` | PENDING CAPTURE (orchestrator, final pass) |
| `nfs.txt` | `tf-metrics-nfs` | PENDING CAPTURE (orchestrator, final pass) |
| `non-linux.txt` | `tf-metrics-darwin` | PENDING CAPTURE (orchestrator, final pass) |

From the core worktree root, in a POSIX terminal on the capture controller,
define the following helper (Python 3 and Cargo are controller-side only).
Use existing disposable host access with POSIX `awk` already installed
(the BusyBox applet is sufficient); do not install anything on the remote
host for the capture. The ignored emitter prints the exact production
`collector_command()` with a fresh nonce. The helper passes it unchanged to
one SSH exec per invocation; redirect stdout only. Keep the session nonce
unchanged when sanitizing.

```sh
capture_tfm() {
    python3 - "$1" <<'PY'
import subprocess
import sys

emitted = subprocess.check_output(
    ["cargo", "test", "--lib", "ssh::metrics::tests::print_collector_command_for_capture",
     "--", "--exact", "--ignored", "--nocapture"],
    cwd="src-tauri",
)
prefix = b"TERMFLOW_COLLECTOR_COMMAND="
[command] = [line.partition(prefix)[2] for line in emitted.splitlines() if prefix in line]
subprocess.run(["ssh", "-T", sys.argv[1], command.decode("ascii")], check=True)
PY
}
capture_tfm tf-metrics-ubuntu  > src-tauri/src/ssh/metrics/fixtures/ubuntu.txt
capture_tfm tf-metrics-alpine  > src-tauri/src/ssh/metrics/fixtures/alpine.txt
capture_tfm tf-metrics-nfs     > src-tauri/src/ssh/metrics/fixtures/nfs.txt
capture_tfm tf-metrics-darwin  > src-tauri/src/ssh/metrics/fixtures/non-linux.txt
```

Use Ubuntu with working `who` and no NFS, Alpine with `/bin/sh` provided by
BusyBox ash and no usable `who`, Linux with a confirmed local mount, NFSv4
(also NFSv3 if available), tmpfs and CIFS, and macOS reporting Darwin.
Record OS release, kernel release, BusyBox version (or N/A), shell backing
`sh`, host setup and one-exec trace in the table after capture. Record
version provenance separately from stdout. Replace sensitive identities with
consistent pseudonyms across the capture without changing numeric values,
framing, statuses, whitespace, escape forms, or source/mount joins. Inspect
the sanitized bytes independently and fill the literal oracles
`UBUNTU_FIELDS`, `ALPINE_MEM_TOTAL`, `NFS_LOCAL_IDENTITIES`, and
`NFS_REMOTE_IDENTITIES`; do not derive expected values from parser output.

`derived-malformed.txt` is a handwritten malformed section fragment.
`derived-who-permission.txt` is a handwritten partial stdout fragment inserted
under a nonzero permission status. In-memory protocol variants and recording
utility outputs are also synthetic, not host captures.
