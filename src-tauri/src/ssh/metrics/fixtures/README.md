# SSH metrics: collector capture provenance

Captured 2026-11-21 (T8b). Each capture is one exec of the production
`collector_command()` with its own fresh nonce, stdout only. Literal oracles in
`../protocol/tests.rs` were read from the sanitized bytes, not from parser output.
`.gitattributes` keeps these files byte-exact (no CRLF conversion on checkout).

| Fixture | Alias | Provenance |
|---|---|---|
| `ubuntu.txt` | `tf-metrics-ubuntu` | **Captured.** Ubuntu 24.04.3 LTS on WSL2, kernel 6.18.33.2-microsoft-standard-WSL2, GNU coreutils `who`/`df`, `sh` = dash. One `ssh -T` exec against a throwaway loopback sshd (127.0.0.1:2470, throwaway host and client keys, `UsePAM no`); sshd log shows one accepted publickey session. 75,439 bytes. A docker/snap host, so it carries real stacked mounts, `rootfs`, `9p`, WSL `overlay` and `fuse.snapfuse` rows. |
| `alpine.txt` | `tf-metrics-alpine` | **Captured** with the collector after the BusyBox fix (commit 6142372). Alpine 3.20.10 (`alpine:3.20`, digest `sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc`), BusyBox v1.36.1, `/bin/sh` = BusyBox ash, host kernel 6.18.33.2-microsoft-standard-WSL2. One `docker run --rm alpine:3.20 sh -c <collector_command>` in WSL Docker, not an SSH exec: no sshd or package install in the image (leader ruling D55); the image was not present before and was removed afterwards. No utmp, so `who` reports 123 (login records unavailable). BusyBox df has no `-l`, so dfLocal comes from the typed per-type fallback; as a container it also lists the runtime's file bind mounts (`/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`) as ext4 rows of the host disk, which a VM would not. |
| `nfs.txt` | `tf-metrics-nfs` | **DERIVED, NOT CAPTURED** (no NFS host; privileged containers/kernel modules ruled out, leader ruling D55; real NFS capture deferred). The real `ubuntu.txt` envelope, with only `mounts`, `dfLocal` and `dfNfs` replaced by this modeled table: `/dev/sda1 /` ext4; `proc`; `tmpfs /run`, `/dev/shm`; `/dev/sdb1 /data\040disk` xfs; `nas.example:/export/home /mnt/home` nfs4 (vers=4.2); `nas.example:/export/old /mnt/old` nfs (vers=3); `//nas.example/share /mnt/smb` cifs. dfLocal models GNU `df -l -P -T` (cifs and NFS absent), dfNfs models GNU `df -P -t nfs -t nfs4` (no Type column, blank separator line). |
| `non-linux.txt` | `tf-metrics-darwin` | **Captured.** macOS host, `uname -s` Darwin, `uname -m` arm64; zsh login shell. One read-only `ssh -T` exec (BatchMode, existing known_hosts entry via HostKeyAlias). macOS version not recorded: the grant was exactly one exec. 519 bytes. |

Sanitization: hostnames become the alias (`ubuntu.txt`, `nfs.txt`, `non-linux.txt`);
in `ubuntu.txt` the runner mount `/srv/<name>` became `/srv/runner-data` in both
`mounts` and `dfLocal` (join preserved). Nothing else changed: numbers, framing,
statuses, whitespace and escapes are byte-identical to the raw capture.

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

Darwin: synthesized from sanitized real macOS 26.5.2 arm64 command output, 2026-11-23. Source: darwin-commands.txt and darwin-commands.sh.txt. The iostat two header lines and first data row were synthesized around the captured final interval row (duplicated for the first row); all other command values are unchanged. Nonce is fixed for tests.
