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

## Windows

`windows.txt`: **local console capture; sshd capture pending live test**.
Windows 11 Pro 10.0.26300.9974, Windows PowerShell 5.1, local console.
The WMI-free collector ran through the production UTF-16LE bootstrap under
`cmd.exe /d /c` (6,886 command bytes). Stdout was
captured with LF line endings. Host, users, adapter names (including the
brackets and numbered suffixes), and the UNC host/share were pseudonymized;
the measurements and section statuses were not changed. A mapped network
drive in the console is not evidence of a mapping in the sshd logon session.

`windows-sshd-nonadmin.txt`: **captured over sshd**. One exec of the production
command, using the WMI-free collector before its exit path changed, as the local
non-admin account `tf-sshtest`, which is a member of Users only. The command ran
over Win32-OpenSSH 9.5 with DefaultShell = Windows PowerShell 5.1, on the same
host, on 2026-11-23. Stdout only, with LF endings. The nonce became the fixture
nonce and the hostname became `WINHOST`. Adapter names are the host's generic
ones and were kept. `winUsers` ends 1 because quser refuses non-admin network
logons; WMI was refused the same way, which is why the collector does not use it.
Wall time over sshd, from exec start to exit, was 0.9–1.7 s per run. The process
used 0.45–0.52 s of CPU, and defining the native type took 43–52 ms.
`[Environment]::Exit` added about 2.5 s under sshd, so the script ends with a
plain `exit 0`, and the hung-share path uses `TerminateProcess`.
`windows-clm.txt` is a separate local capture: the child used
`__PSLockdownPolicy=4` and explicitly entered Constrained Language Mode when
retail PowerShell ignored that variable. Output was ASCII with LF endings;
host, architecture, registry OS and available quser data survived.

The other variants are derived: CRLF, no quser (127), users denied (126),
an empty Size drive, watchdog (137), and an escaped Unicode hostname (including
a UTF-16 surrogate pair).

Windows collection uses the same ten-second cadence and five-second deadline.
The first tick tries POSIX; a framing-free command failure can move Windows
detection to the next tick. The bootstrap assumes `powershell` is on the outer
shell's PATH and is not shadowed by a profile alias or function. Outer profile
startup counts against the deadline. Encoded commands may be blocked by
endpoint policy; load average is unavailable, and quser excludes SSH sessions.

`derived-malformed.txt` is a handwritten malformed section fragment.
`derived-who-permission.txt` is a handwritten partial stdout fragment inserted
under a nonzero permission status. In-memory protocol variants and recording
utility outputs are also synthetic, not host captures.
