//! Backlog 003: open a detected URL / file path / editor target from terminal
//! output. Implemented as our own commands using std::process::Command (the
//! codebase's existing pattern, cf. pty_manager::kill_process_tree) so there is no
//! plugin capability to configure and we keep full control of the executable guard.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// Bounds for the descendant fallback search (backlog 003 follow-up). Kept tight so a
// missed click never becomes a disk-wide crawl. The walk runs on a blocking worker
// (see commands::resolve_terminal_path), so the UI thread / output pipeline is never
// blocked while it runs.
const SEARCH_MAX_DIRS: usize = 12_000;
const SEARCH_MAX_DEPTH: usize = 12;
const SEARCH_MAX_CANDIDATES: usize = 25;
const SEARCH_TIME_BUDGET_MS: u64 = 1_500;

// Heavy / generated directories we never descend into during the fallback search.
const SEARCH_IGNORE_DIRS: &[&str] = &[
    "node_modules", ".git", ".hg", ".svn", "target", "dist", "build", "out", ".next",
    ".nuxt", ".cache", ".turbo", "vendor", "bin", "obj", ".venv", "venv", "__pycache__",
    ".gradle", ".idea", ".vs", "coverage",
];

fn is_ignored_dir(name: &str) -> bool {
    SEARCH_IGNORE_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// Strip a single leading `./` (or `.\`) and any leading separators so a relative
/// path joins cleanly *under* a base directory. A leading `..` is preserved.
fn strip_rel_prefix(rel: &str) -> &str {
    let r = rel.strip_prefix("./").or_else(|| rel.strip_prefix(".\\")).unwrap_or(rel);
    r.trim_start_matches(['/', '\\'])
}

/// Join `rel` under `cwd`, OS-normalizing separators first.
fn join_under(cwd: &str, rel: &str) -> PathBuf {
    let rel_n = normalize_separators(rel);
    Path::new(cwd).join(strip_rel_prefix(&rel_n))
}

/// Present a canonicalized path to the renderer without Windows' `\\?\` verbatim
/// prefix (which some handlers — explorer.exe, editors — dislike).
fn path_to_string(p: PathBuf) -> String {
    let s = p.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

/// Find every existing file reachable as `<descendant-of-base>/rel` by BFS-walking
/// `base`'s subtree and testing `dir.join(rel)`. Shallowest matches come first
/// (BFS). Bounded by dir-count, depth, candidate-count and a wall-clock budget; heavy
/// dirs (node_modules, .git, target, …) are pruned; symlinked dirs are skipped to
/// avoid cycles. A bare filename (no separator) is rejected as too ambiguous.
fn find_descendants(base: &Path, rel: &str) -> Vec<PathBuf> {
    let rel_n = normalize_separators(rel);
    let rel = strip_rel_prefix(&rel_n);
    if !rel.contains('/') && !rel.contains('\\') {
        return Vec::new();
    }
    let mut out: Vec<PathBuf> = Vec::new();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((base.to_path_buf(), 0));
    let mut visited = 0usize;
    let start = Instant::now();
    while let Some((dir, depth)) = queue.pop_front() {
        if visited >= SEARCH_MAX_DIRS
            || out.len() >= SEARCH_MAX_CANDIDATES
            || start.elapsed() > Duration::from_millis(SEARCH_TIME_BUDGET_MS)
        {
            break;
        }
        visited += 1;
        let candidate = dir.join(rel);
        if candidate.is_file() {
            if let Ok(c) = std::fs::canonicalize(&candidate) {
                if !out.contains(&c) {
                    out.push(c);
                }
            }
        }
        if depth >= SEARCH_MAX_DEPTH {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                if !ft.is_dir() {
                    continue;
                }
                let name = entry.file_name();
                if is_ignored_dir(&name.to_string_lossy()) {
                    continue;
                }
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }
    out
}

/// Resolve a relative path the terminal printed, against an ordered list of candidate
/// base dirs (the OSC-reported shell cwd, then the live foreground-process cwd). The
/// FIRST base whose direct join exists wins deterministically (returns one path). Only
/// when no base resolves directly do we fall back to a bounded descendant search from
/// the outermost base — which may return zero, one, or many candidates (the renderer
/// shows a picker for many). Pure fs logic (no app state) so it is unit-testable.
pub(crate) fn resolve_blocking(bases_in: &[Option<String>], rel: &str) -> Vec<String> {
    let mut bases: Vec<String> = Vec::new();
    for b in bases_in.iter().flatten() {
        if !bases.contains(b) {
            bases.push(b.clone());
        }
    }
    // Deterministic: first base whose direct join exists (file OR directory).
    for base in &bases {
        if let Ok(c) = std::fs::canonicalize(join_under(base, rel)) {
            return vec![path_to_string(c)];
        }
    }
    // Fuzzy fallback: search the outermost base's subtree for the relative chain.
    match bases.first() {
        Some(root) => find_descendants(Path::new(root), rel)
            .into_iter()
            .map(path_to_string)
            .collect(),
        None => Vec::new(),
    }
}

/// Extensions the OS would EXECUTE rather than view when handed to its default
/// "open/run" association (backlog 003 safety guard). Includes Windows indirect-
/// execution vectors (.lnk/.url shortcuts, .wsf/.hta scripts, .reg/.pif). These are
/// NEVER auto-run by us: in the no-editor `open_path` route a click on one of these
/// REVEALS the file in the OS file manager instead (see open_path) — the user can
/// then act on it deliberately. With a default editor configured the renderer calls
/// `open_in_editor` (no guard), so these still open as text in the chosen editor.
///
/// NB: source types like .py/.rb/.pl are intentionally NOT listed — they are inert
/// when opened (no double-click-runs association) and are the whole point of the
/// feature (jump from a stack trace / compiler error).
const EXECUTABLE_EXTS: &[&str] = &[
    "exe", "bat", "cmd", "com", "msi", "scr", "ps1", "sh", "vbs", "vbe", "js", "jar", "app",
    "lnk", "url", "wsf", "hta", "reg", "pif", "cpl", "msc", "scf", "jse", "wsc", "wsh",
];

/// Make a path use the host's native separator. On Windows, `explorer.exe` (and the
/// path the user expects) needs backslashes — a forward-slash or mixed-separator
/// path like `D:\proj\src/main.rs` otherwise fails with "File not found". On Unix a
/// `\` is a legal filename char, so we leave non-Windows paths untouched.
fn normalize_separators(path: &str) -> String {
    if cfg!(target_os = "windows") {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

/// Map a Git-Bash/MSYS drive path (`/d/sources`) or a WSL mount path
/// (`/mnt/d/sources`) to a native Windows drive path (`D:\sources`). Also handles the
/// bare-drive forms (`/d` / `/mnt/d` -> `D:\`). Returns `None` for anything that isn't
/// one of those two shapes — including genuine POSIX paths whose first segment isn't a
/// single drive letter (`/usr/lib`, `/mnt/wsl/…`); those get no drive mapping (on
/// Windows the caller still slash-normalizes them via `normalize_separators`).
///
/// This is compiled on every platform so the Linux CI can unit-test it, but it is only
/// ever CALLED on Windows (see `to_native_path`): on Unix `/d/sources` and `/mnt/d/…`
/// are real paths and must NOT be rewritten.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn msys_or_wsl_drive(path: &str) -> Option<String> {
    // Build `<DRIVE>:\<rest>` from a drive letter and the remainder after it (which is
    // either empty or begins with `/`). Slashes in the tail become backslashes.
    fn to_win(drive: u8, after_letter: &str) -> String {
        let drive = drive.to_ascii_uppercase() as char;
        // Trim the boundary separator (either kind) so a `\` after the drive doesn't
        // become a doubled `D:\\…`, then normalize the rest to backslashes.
        let tail = after_letter
            .trim_start_matches(|c| c == '/' || c == '\\')
            .replace('/', "\\");
        if tail.is_empty() {
            format!("{drive}:\\")
        } else {
            format!("{drive}:\\{tail}")
        }
    }
    // `body` is the path with its distinguishing prefix (`/` or `/mnt/`) removed; it is
    // a drive only when it's `<letter>` or `<letter>` followed by a `/` or `\` boundary
    // (tools sometimes print a mixed-separator path like `/mnt/d\proj`).
    fn drive_from(body: &str) -> Option<(u8, &str)> {
        let b = body.as_bytes();
        let d = *b.first()?;
        if d.is_ascii_alphabetic() && (b.len() == 1 || b[1] == b'/' || b[1] == b'\\') {
            Some((d, &body[1..]))
        } else {
            None
        }
    }

    if let Some(rest) = path.strip_prefix("/mnt/") {
        // WSL mount: only a single-letter segment is a drive (skips /mnt/wsl, …).
        return drive_from(rest).map(|(d, after)| to_win(d, after));
    }
    let rest = path.strip_prefix('/')?;
    drive_from(rest).map(|(d, after)| to_win(d, after))
}

/// Turn a terminal-printed path into one the host OS can open. On Windows this first
/// remaps Git-Bash/WSL drive paths (`/d/…`, `/mnt/d/…`) to `D:\…`, then normalizes
/// separators; on every other OS it is exactly `normalize_separators` — a `/d/…` path
/// there is a genuine POSIX path and is left alone.
fn to_native_path(path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        if let Some(win) = msys_or_wsl_drive(path) {
            return win;
        }
    }
    normalize_separators(path)
}

/// True when `program` is a Windows batch launcher (`.cmd`/`.bat`), which std runs
/// through cmd.exe. From this GUI (windows-subsystem) process that intermediate
/// cmd.exe would get a brand-new console window — a visible flash on every
/// ctrl-click open — unless suppressed with CREATE_NO_WINDOW (see open_in_editor).
/// Compiled on every platform so the Linux CI can unit-test it; only consulted on
/// Windows.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_batch_shim(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

fn is_executable_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| EXECUTABLE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// True for the VS Code family (code / code-insiders / codium / vscodium), which
/// accepts `-g <file>:<line>:<col>` for go-to-line. Splits on BOTH separators
/// explicitly (not `std::path::Path`, whose parsing is platform-specific) so a
/// Windows `…\code.exe` / `…\code.cmd` editor path is recognized on any host.
fn is_vscode_family(editor: &str) -> bool {
    let base = editor
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(editor)
        .to_ascii_lowercase();
    // Strip whichever launcher extension the user may have typed (code, code.exe,
    // code.cmd — the Windows shim is a .cmd).
    let stem = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".cmd"))
        .or_else(|| base.strip_suffix(".bat"))
        .unwrap_or(&base);
    matches!(stem, "code" | "code-insiders" | "codium" | "vscodium")
}

/// Resolve a bare editor command (e.g. `code`) to a concrete executable path by
/// scanning `PATH`, honoring Windows `PATHEXT` (`.cmd`/`.bat`/`.exe`/…).
///
/// Why (Windows only): VS Code (and many CLIs) ship on Windows as a `code.cmd`
/// shim. The user's shell finds it via PATHEXT, but `Command::new("code")` does
/// NOT — `CreateProcess` only appends `.exe` when searching PATH — so a user-typed
/// "code" failed with "program not found". We mirror the shell's PATHEXT lookup.
/// (Rust 1.77.2+ then runs a resolved `.cmd`/`.bat` through cmd.exe with safe
/// argument escaping.)
///
/// On non-Windows this returns `None` on purpose: the OS's `execvp` PATH search
/// (which `Command::new("code")` delegates to for a name without a separator) is
/// the right tool — it honors the executable bit and skips non-executable files.
/// Returning an absolute path here would instead make `Command` bypass `execvp`
/// and try to run a possibly non-executable match directly (→ EACCES).
///
/// Also returns `None` when `editor` already contains a path separator (used
/// verbatim) or nothing matches — the caller then passes the original string
/// straight to `Command`, preserving absolute paths and Unix's native lookup.
fn resolve_in_path(editor: &str) -> Option<PathBuf> {
    if editor.contains('/') || editor.contains('\\') {
        return None;
    }
    // Non-Windows: defer to native execvp (see doc comment above).
    #[cfg(not(windows))]
    {
        None
    }
    #[cfg(windows)]
    {
        let path_var = std::env::var_os("PATH")?;
        // Mirror cmd.exe: a bare command name is resolved by APPENDING a PATHEXT
        // extension. An extensionless file is NOT a runnable Win32 program and must
        // be skipped — VS Code's `bin` dir ships BOTH `code` (a Bash shim, no ext)
        // and `code.cmd`; matching the bare `code` makes CreateProcess fail with
        // "%1 is not a valid Win32 application" (os error 193). We only fall back to
        // the as-typed name when the user already gave a known executable extension
        // (e.g. typed "code.cmd" / "foo.exe").
        let pathext: Vec<String> = match std::env::var_os("PATHEXT") {
            Some(pe) => pe
                .to_string_lossy()
                .split(';')
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(|e| e.to_ascii_lowercase())
                .collect(),
            None => [".com", ".exe", ".bat", ".cmd"].map(String::from).to_vec(),
        };
        let lower = editor.to_ascii_lowercase();
        let already_has_ext = pathext.iter().any(|e| lower.ends_with(e.as_str()));
        let mut exts: Vec<String> = Vec::new();
        if already_has_ext {
            exts.push(String::new());
        }
        exts.extend(pathext);

        // dir (outer) then ext (inner): matches cmd.exe — an earlier PATH dir wins,
        // and within a dir the PATHEXT order decides.
        for dir in std::env::split_paths(&path_var) {
            for ext in &exts {
                let candidate = dir.join(format!("{editor}{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

/// Build editor launch args. For the VS Code family with a line, use `-g
/// <file>:<line>:<col>`; otherwise just the file path (an unknown editor would
/// treat a stray `-g` / `file:line` as extra files to create).
fn editor_args(editor: &str, path: &str, line: Option<u32>, col: Option<u32>) -> Vec<String> {
    match (line, is_vscode_family(editor)) {
        (Some(l), true) => {
            let target = match col {
                Some(c) => format!("{}:{}:{}", path, l, c),
                None => format!("{}:{}", path, l),
            };
            vec!["-g".to_string(), target]
        }
        _ => vec![path.to_string()],
    }
}

/// Open a target with the OS default handler.
fn os_open(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Use explorer.exe (a native binary launched via CreateProcessW), NOT
        // `cmd /C start`: cmd would expand `%VAR%` even inside quotes and treat
        // `&`/newlines as command separators, which a crafted target could abuse.
        // explorer opens URLs and files with their default handler and receives the
        // target as a single argv arg (Rust quotes spaces) — no shell parsing.
        std::process::Command::new("explorer.exe")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Reveal a file in the OS file manager (selecting it where supported) WITHOUT
/// opening/running it. Used for execution-bearing types in the no-editor route so a
/// click never auto-executes a `.bat`/`.lnk`/`.exe` — the user lands on the file in
/// its folder and decides what to do.
fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // explorer.exe /select,<path> highlights the file in its parent folder.
        // explorer uses its OWN command-line parser, so we must control quoting
        // exactly: std's default quoting wraps the whole `/select,C:\a b\f` token,
        // which explorer mis-parses (falls back to opening Documents) and it also
        // splits on commas. Emit `/select,"<path>"` verbatim via raw_arg so the path
        // (spaces, commas) is protected. Windows filenames can't contain `"`.
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        // -R reveals (selects) the file in Finder instead of opening it. `--` ends
        // option parsing so a `-`-prefixed path can't be read as a flag.
        std::process::Command::new("open")
            .args(["-R", "--", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select in file manager" call; open the parent directory.
        let parent = Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string());
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Open a (non-executable) file in the OS-native text editor for the no-editor route.
/// Deliberately NOT the OS "run/open" association (`os_open`): a default association
/// could execute script types, whereas a text editor only ever reads the bytes.
fn open_in_text_editor(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("notepad.exe")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        // -t opens in the default text editor (TextEdit) rather than the file's
        // default app, keeping the "view as text" intent. `--` ends option parsing
        // so a `-`-prefixed path can't be read as a flag.
        std::process::Command::new("open")
            .args(["-t", "--", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No universal text-editor launcher; defer to the association. Extension-
        // bearing execution vectors were already diverted to reveal_in_file_manager
        // by open_path, and `path` is absolute here so xdg-open won't treat it as a
        // flag. Residual (pre-existing) Linux gap: an EXTENSIONLESS executable with
        // the exec bit set isn't caught by is_executable_path and would be run by the
        // association — acceptable for now; the primary target platform is Windows.
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("refusing to open non-http(s) URL: {}", url));
    }
    os_open(&url)
}

#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    // OS-aware native path first (Windows only): remap Git-Bash/WSL drive paths
    // (`/d/…`, `/mnt/d/…`) to `D:\…` and switch forward slashes to backslashes, so a
    // clicked path explorer.exe / canonicalize can actually resolve. No-op off Windows.
    let path = to_native_path(&path);
    // Canonicalize first: this both confirms the file exists AND resolves symlinks,
    // so the executable-extension guard inspects the REAL target (a `safe.txt`
    // symlink pointing at `calc.exe` can't sneak past the check).
    let canonical = std::fs::canonicalize(&path).map_err(|_| format!("File not found: {}", path))?;
    let is_dir = canonical.is_dir();
    // Hand launchers the RESOLVED, absolute path (`\\?\`-prefix stripped): this both
    // closes the check→use symlink race (we act on the same target we vetted) and
    // guarantees an absolute path, so it can never begin with `-` and be misparsed as
    // a flag by `open`/`xdg-open`.
    let resolved = path_to_string(canonical);
    // Execution-bearing type FIRST — this MUST precede the is_dir shortcut below: a
    // macOS `.app` bundle is BOTH a directory and an executable extension, so if is_dir
    // won the race, os_open would LAUNCH the bundle. Never run it; reveal it in the file
    // manager so the user can act on it deliberately (was: hard refusal). The
    // original-path check stays as a belt-and-suspenders guard alongside the resolved one.
    if is_executable_path(&resolved) || is_executable_path(&path) {
        return reveal_in_file_manager(&resolved);
    }
    if is_dir {
        // A (non-executable) directory isn't text: open it in the OS file manager
        // (Explorer/Finder/xdg-open) rather than handing it to a text editor.
        return os_open(&resolved);
    }
    // No default editor is configured (the renderer only calls open_path in that
    // fallback). Open in the OS-native text editor rather than the OS run/open
    // association — the latter could execute associated handlers.
    open_in_text_editor(&resolved)
}

#[tauri::command]
pub async fn open_in_editor(
    editor: String,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
) -> Result<(), String> {
    // Same OS-aware remap as open_path: a clicked `/d/…` or `/mnt/d/…` path must reach
    // the editor as `D:\…` on Windows (no-op off Windows).
    let path = to_native_path(&path);
    if !Path::new(&path).exists() {
        return Err(format!("File not found: {}", path));
    }
    if Path::new(&path).is_dir() && !is_vscode_family(&editor) {
        // A directory: the VS Code family opens a folder as a workspace, so let it fall
        // through to the editor launch below (`code <dir>`). Any other editor can't
        // sensibly open a directory, so open it in the OS file manager instead.
        return os_open(&path);
    }

    // macOS: a `.app` is a directory bundle, not an executable — `Command::new` on
    // it fails (EISDIR). The Browse picker can return such a bundle, so launch it
    // via `open -a "<bundle>" <file>` (LaunchServices opens the file in that app).
    // Go-to-line isn't expressible through `open`, so the file opens at the top.
    #[cfg(target_os = "macos")]
    {
        if editor.to_ascii_lowercase().trim_end_matches('/').ends_with(".app") {
            return std::process::Command::new("open")
                .arg("-a")
                .arg(&editor)
                .arg(&path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Failed to launch editor '{}': {}", editor, e));
        }
    }

    // Resolve `code` → its real `code.cmd`/`code.exe` via PATH+PATHEXT so a bare
    // command name works like it does in the user's shell. Falls back to the
    // as-typed name (absolute paths, Unix native execvp lookup) when it can't.
    let program = resolve_in_path(&editor)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| editor.clone());
    // NOTE (Windows): when `program` is a `.cmd`/`.bat` shim, std runs it through
    // cmd.exe. Argument *injection* is mitigated (Rust ≥1.77.2 / CVE-2024-24576),
    // but cmd.exe still expands `%VAR%` inside the file-path arg. In practice the
    // path is a real on-disk file the user clicked; a literal `%name%` segment is
    // an accepted edge-case limitation of launching through a batch shim.
    let mut cmd = std::process::Command::new(&program);
    // Build args from the user-typed name so VS Code detection (-g go-to-line)
    // still fires even though `program` may now be `…\code.cmd`.
    cmd.args(editor_args(&editor, &path, line, col));
    // Batch shims run through cmd.exe, which — spawned from a GUI process — pops a
    // console window that flashes and closes. CREATE_NO_WINDOW suppresses it.
    // Scoped to `.cmd`/`.bat` only: a console editor the user configured directly
    // (e.g. vim.exe) still needs a real console window to appear in.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if is_batch_shim(&program) {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }
    cmd.spawn()
        .map(|_| ())
        // A missing editor surfaces as a bare OS error ("No such file or directory");
        // name the editor so the user can fix the defaultEditor setting.
        .map_err(|e| format!("Failed to launch editor '{}': {}", editor, e))
}

#[cfg(test)]
mod tests {
    use super::{
        editor_args, find_descendants, is_batch_shim, is_executable_path, is_vscode_family,
        msys_or_wsl_drive, normalize_separators, resolve_blocking, resolve_in_path,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Unique temp dir per call (no tempfile dep): pid + monotonic counter.
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    fn temp_root() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("at-resolve-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn touch(path: &PathBuf) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"x").unwrap();
    }

    #[test]
    fn find_descendants_finds_all_matches_and_prunes_heavy_dirs() {
        let root = temp_root();
        let rel = "cicd/docs/deployment/050-x.md";
        // Two real matches in different subfolders + one inside node_modules (ignored).
        touch(&root.join("rephlo-sites").join("cicd/docs/deployment/050-x.md"));
        touch(&root.join("other").join("cicd/docs/deployment/050-x.md"));
        touch(&root.join("node_modules/pkg").join("cicd/docs/deployment/050-x.md"));

        let found = find_descendants(&root, rel);
        assert_eq!(found.len(), 2, "should find both non-ignored matches: {:?}", found);
        assert!(found.iter().all(|p| !p.to_string_lossy().contains("node_modules")));

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn find_descendants_rejects_a_bare_filename() {
        let root = temp_root();
        touch(&root.join("sub").join("only.md"));
        // No separator → too ambiguous → no fuzzy search.
        assert!(find_descendants(&root, "only.md").is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_blocking_prefers_direct_join_then_falls_back_to_search() {
        let root = temp_root();
        let rel = "cicd/deploy.md";
        // The file lives ONLY under the subfolder the agent cd'd into.
        touch(&root.join("rephlo-sites").join("cicd/deploy.md"));

        // Base = the (wrong) shell cwd `root`: direct join misses, search finds the one match.
        let one = resolve_blocking(&[Some(root.to_string_lossy().into_owned())], rel);
        assert_eq!(one.len(), 1);
        assert!(one[0].replace('/', "\\").ends_with("rephlo-sites\\cicd\\deploy.md")
            || one[0].ends_with("rephlo-sites/cicd/deploy.md"));

        // Add the correct base as a second candidate: now the DIRECT join wins (no search).
        let correct = root.join("rephlo-sites").to_string_lossy().into_owned();
        let direct = resolve_blocking(&[Some(root.to_string_lossy().into_owned()), Some(correct)], rel);
        assert_eq!(direct.len(), 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resolve_blocking_returns_many_for_an_ambiguous_relative_path() {
        let root = temp_root();
        let rel = "cicd/deploy.md";
        touch(&root.join("a").join("cicd/deploy.md"));
        touch(&root.join("b").join("cicd/deploy.md"));
        // No base resolves directly → search yields BOTH (the renderer shows a picker).
        let many = resolve_blocking(&[Some(root.to_string_lossy().into_owned())], rel);
        assert_eq!(many.len(), 2, "ambiguous path should surface both candidates: {:?}", many);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn normalizes_separators_per_os() {
        if cfg!(target_os = "windows") {
            // Forward-slash and mixed-separator paths become native backslash paths.
            assert_eq!(normalize_separators("D:\\proj\\src/main.rs"), "D:\\proj\\src\\main.rs");
            assert_eq!(
                normalize_separators("Rephlo.UI/ViewModels/X.cs"),
                "Rephlo.UI\\ViewModels\\X.cs"
            );
        } else {
            // On Unix `\` is a legal filename char, so paths pass through untouched.
            assert_eq!(normalize_separators("/home/u/proj/main.rs"), "/home/u/proj/main.rs");
        }
    }

    #[test]
    fn maps_msys_and_wsl_drive_paths() {
        // Git-Bash/MSYS single-letter drive → Windows drive path.
        assert_eq!(msys_or_wsl_drive("/d/sources").as_deref(), Some("D:\\sources"));
        assert_eq!(
            msys_or_wsl_drive("/c/Users/me/main.rs").as_deref(),
            Some("C:\\Users\\me\\main.rs")
        );
        // WSL mount path → the same Windows drive path.
        assert_eq!(msys_or_wsl_drive("/mnt/d/sources").as_deref(), Some("D:\\sources"));
        assert_eq!(
            msys_or_wsl_drive("/mnt/c/Users/me").as_deref(),
            Some("C:\\Users\\me")
        );
        // Bare-drive forms map to the drive root.
        assert_eq!(msys_or_wsl_drive("/d").as_deref(), Some("D:\\"));
        assert_eq!(msys_or_wsl_drive("/mnt/d").as_deref(), Some("D:\\"));
        // A lowercase drive letter is upper-cased; a trailing slash is preserved as root.
        assert_eq!(msys_or_wsl_drive("/D/sources").as_deref(), Some("D:\\sources"));
        assert_eq!(msys_or_wsl_drive("/mnt/e/").as_deref(), Some("E:\\"));
        // Mixed separators after the drive letter (a `\` boundary / tail) map cleanly —
        // no doubled backslash.
        assert_eq!(msys_or_wsl_drive("/mnt/d\\proj\\src").as_deref(), Some("D:\\proj\\src"));
        assert_eq!(msys_or_wsl_drive("/d\\sources").as_deref(), Some("D:\\sources"));
        // A non-ASCII tail is preserved.
        assert_eq!(msys_or_wsl_drive("/mnt/c/Users/中文").as_deref(), Some("C:\\Users\\中文"));
    }

    #[test]
    fn leaves_genuine_posix_paths_untouched() {
        // First segment isn't a single drive letter → not our shape (real POSIX path).
        assert_eq!(msys_or_wsl_drive("/usr/lib/foo.so"), None);
        assert_eq!(msys_or_wsl_drive("/home/u/proj"), None);
        // /mnt but not a drive (e.g. the WSL interop mount) → left alone.
        assert_eq!(msys_or_wsl_drive("/mnt/wsl/instance"), None);
        // Already-native and relative paths aren't POSIX-absolute → None.
        assert_eq!(msys_or_wsl_drive("D:\\already\\win"), None);
        assert_eq!(msys_or_wsl_drive("src/main.rs"), None);
        assert_eq!(msys_or_wsl_drive("/"), None);
        // UNC-ish and bare /mnt forms aren't drive shapes → left for normalize_separators.
        assert_eq!(msys_or_wsl_drive("//server/share"), None);
        assert_eq!(msys_or_wsl_drive("/mnt"), None);
        assert_eq!(msys_or_wsl_drive("/mnt/"), None);
    }

    #[test]
    fn flags_executables() {
        // Execution-bearing types: diverted to reveal-in-folder (not run) in open_path.
        assert!(is_executable_path("C:\\tmp\\setup.exe"));
        assert!(is_executable_path("C:\\tmp\\install.msi"));
        assert!(is_executable_path("C:\\tmp\\run.bat"));
        assert!(is_executable_path("/usr/local/bin/x.sh"));
        assert!(is_executable_path("C:\\tmp\\macro.vbs"));
        assert!(is_executable_path("C:\\tmp\\app.js"));
        // Windows indirect-execution vectors must also be flagged.
        assert!(is_executable_path("C:\\tmp\\shortcut.lnk"));
        assert!(is_executable_path("C:\\tmp\\link.url"));
        assert!(is_executable_path("C:\\tmp\\app.hta"));
        // Inert source/text types open in the editor.
        assert!(!is_executable_path("src/main.rs"));
        assert!(!is_executable_path("notes")); // no extension
    }

    #[test]
    fn builds_editor_args() {
        // VS Code family gets -g go-to-line.
        assert_eq!(editor_args("code", "a.rs", None, None), vec!["a.rs"]);
        assert_eq!(editor_args("code", "a.rs", Some(12), None), vec!["-g", "a.rs:12"]);
        assert_eq!(editor_args("code", "a.rs", Some(12), Some(4)), vec!["-g", "a.rs:12:4"]);
        assert_eq!(
            editor_args("C:\\Program Files\\Microsoft VS Code\\code.exe", "a.rs", Some(7), None),
            vec!["-g", "a.rs:7"]
        );
        // Unknown editors just get the file (no stray -g / file:line junk arg).
        assert_eq!(editor_args("notepad", "a.rs", Some(12), Some(4)), vec!["a.rs"]);
        assert_eq!(editor_args("vim", "a.rs", Some(12), None), vec!["a.rs"]);
    }

    #[test]
    fn detects_vscode_family_including_cmd_shim() {
        // Bare name, .exe, and the Windows .cmd shim all count as VS Code.
        assert!(is_vscode_family("code"));
        assert!(is_vscode_family("code.exe"));
        assert!(is_vscode_family("code.cmd"));
        assert!(is_vscode_family(r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"));
        assert!(is_vscode_family("code-insiders"));
        assert!(!is_vscode_family("notepad"));
        assert!(!is_vscode_family("vim"));
    }

    #[test]
    fn detects_batch_shims_for_console_suppression() {
        // .cmd/.bat launchers run via cmd.exe → console flash without CREATE_NO_WINDOW.
        assert!(is_batch_shim(r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd"));
        assert!(is_batch_shim("code.CMD")); // case-insensitive
        assert!(is_batch_shim("tool.bat"));
        // Real executables (incl. console editors like vim) keep their own window.
        assert!(!is_batch_shim(r"C:\Program Files\Vim\vim.exe"));
        assert!(!is_batch_shim("code"));
        assert!(!is_batch_shim("/usr/bin/code"));
    }

    #[test]
    fn resolve_in_path_skips_names_with_a_separator() {
        // Anything with a path component is used verbatim by the caller (None here).
        assert!(resolve_in_path("some/code").is_none());
        assert!(resolve_in_path(r"C:\tools\code.cmd").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn resolve_in_path_finds_a_bare_command_via_pathext() {
        // Create a fake "myeditor.cmd" launcher on a PATH dir and confirm a bare
        // "myeditor" resolves to it through PATHEXT.
        let root = temp_root();
        let file = root.join("myeditor.cmd");
        touch(&file);

        let saved = std::env::var_os("PATH");
        std::env::set_var("PATH", &root);
        let resolved = resolve_in_path("myeditor");
        // Restore PATH before asserting so a failure can't leak the override.
        match saved {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }

        assert_eq!(resolved.as_deref(), Some(file.as_path()));
        fs::remove_dir_all(&root).ok();
    }

    // On Unix a bare name must defer to the OS's native execvp PATH search (which
    // honors the executable bit), so resolve_in_path returns None even when a
    // matching file exists in PATH — returning an absolute path would bypass execvp
    // and risk running a non-executable match (EACCES). See the fn doc comment.
    #[cfg(not(windows))]
    #[test]
    fn resolve_in_path_defers_to_execvp_on_unix() {
        let root = temp_root();
        touch(&root.join("myeditor")); // a non-executable file in PATH

        let saved = std::env::var_os("PATH");
        std::env::set_var("PATH", &root);
        let resolved = resolve_in_path("myeditor");
        match saved {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }

        assert!(resolved.is_none(), "Unix should defer to execvp (None), got {:?}", resolved);
        fs::remove_dir_all(&root).ok();
    }

    // Regression: VS Code's bin dir ships BOTH `code` (extensionless Bash shim) and
    // `code.cmd`. On Windows the bare shim is not a runnable Win32 program, so
    // resolution must pick `code.cmd` — picking `code` caused os error 193.
    #[cfg(windows)]
    #[test]
    fn resolve_in_path_prefers_cmd_over_extensionless_shim() {
        let root = temp_root();
        touch(&root.join("code")); // Bash shim, no extension
        let cmd = root.join("code.cmd");
        touch(&cmd);

        let saved = std::env::var_os("PATH");
        std::env::set_var("PATH", &root);
        let resolved = resolve_in_path("code");
        match saved {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }

        assert_eq!(resolved.as_deref(), Some(cmd.as_path()));
        fs::remove_dir_all(&root).ok();
    }
}
