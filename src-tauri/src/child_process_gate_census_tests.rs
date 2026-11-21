//! Source-only check: cfg-disabled Mac tests must count on Windows, too.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use syn::{
    parse::Parser,
    punctuated::Punctuated,
    visit::{self, Visit},
    Expr, Item, ItemFn, Token, UseTree,
};

// Cross-module entry points that can launch an OS process (not mock ports or
// RPCs to an already-running host). See the subsystem comments for the effects.
const STARTERS: &[&str] = &[
    // Detached host launch and macOS signing/copy subprocesses.
    "connect_or_spawn",
    "spawn_sidecar_detached",
    "spawn_plain",
    "spawn_disclaimed",
    "spawn_with_spi",
    "libc::posix_spawn",
    "resolve_host_launch",
    "resolve_macos_launch",
    "install_host_bundle_into",
    "validate_source",
    // Test hosts, Bun version probe, and MCP sidecar rig.
    "RealHost::spawn",
    "Sidecar::spawn",
    "Rig::new",
    "bun_binary",
    // Local PTY and OS process-tree cleanup.
    "spawn_terminal",
    "kill_process_tree",
    "kill_process_tree_blocking",
    // MCP/fabric process startup (generic reclaim and handover ports may be fake).
    "start_mcp_legacy",
    "start_mcp_sidecar",
    "respawn_mcp",
    "start_fabric",
    "respawn_fabric",
    // Desktop launchers.
    "spawn_relaunch",
    "ShellExecuteExW",
    "run_as_blocking",
    "launch::run_as",
    "os_open",
    "reveal_in_file_manager",
    "open_in_text_editor",
    "open_permission_pane",
    "open_external",
    "open_path",
    "open_legal_document",
    "open_in_editor",
    // Shell/WSL detection and icon extraction.
    "get_executable_icon",
    "extract_executable_icon",
    "detect_tmux_availability",
    "detect_wsl_distros",
    "check_wsl_tmux",
    "check_native_tmux",
];

#[derive(Default)]
struct Calls {
    paths: BTreeSet<String>,
    methods: BTreeSet<String>,
    imports: BTreeMap<String, String>,
    macros: BTreeSet<String>,
    drops: BTreeSet<String>,
}

fn imports(tree: &UseTree, prefix: &str, names: &mut BTreeMap<String, String>) {
    match tree {
        UseTree::Path(p) => imports(&p.tree, &format!("{prefix}{}::", p.ident), names),
        UseTree::Group(g) => {
            for t in &g.items {
                imports(t, prefix, names);
            }
        }
        UseTree::Name(n) => {
            names.insert(n.ident.to_string(), format!("{prefix}{}", n.ident));
        }
        UseTree::Rename(r) => {
            names.insert(r.rename.to_string(), format!("{prefix}{}", r.ident));
        }
        UseTree::Glob(_) => (),
    }
}

fn spelling(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

impl<'ast> Visit<'ast> for Calls {
    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        imports(&item.tree, "", &mut self.imports);
    }
    fn visit_expr_call(&mut self, expr: &'ast syn::ExprCall) {
        if let Expr::Path(p) = &*expr.func {
            let path = spelling(&p.path);
            if last(&path) == "drop" {
                if let Some(Expr::Path(arg)) = expr.args.first() {
                    self.drops.insert(spelling(&arg.path));
                }
            }
            self.paths.insert(path);
        }
        visit::visit_expr_call(self, expr);
    }
    fn visit_expr_path(&mut self, expr: &'ast syn::ExprPath) {
        let path = spelling(&expr.path);
        // Some bundle resolvers pass these production effects as callbacks.
        if path.contains("bundle_staging::")
            && matches!(last(&path), "validate_source" | "install_host_bundle_into")
        {
            self.paths.insert(path);
        }
    }
    fn visit_expr_method_call(&mut self, expr: &'ast syn::ExprMethodCall) {
        self.methods.insert(expr.method.to_string());
        visit::visit_expr_method_call(self, expr);
    }
    fn visit_item_fn(&mut self, _: &'ast ItemFn) {}
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        self.macros.insert(spelling(&mac.path));
        // assert!, assert_eq!, vec!, format!, and other expression-list macros.
        if let Ok(args) = Punctuated::<Expr, Token![,]>::parse_terminated.parse2(mac.tokens.clone())
        {
            for arg in &args {
                self.visit_expr(arg);
            }
        } else if let Ok(args) =
            Punctuated::<Expr, Token![;]>::parse_terminated.parse2(mac.tokens.clone())
        {
            for arg in &args {
                self.visit_expr(arg);
            }
        }
    }
}

fn last(path: &str) -> &str {
    path.rsplit("::").next().unwrap()
}
fn ends(path: &str, suffix: &str) -> bool {
    path == suffix || path.strip_suffix(suffix).is_some_and(|p| p.ends_with("::"))
}

// These tmux calls start a subprocess with a real configuration, but the tests
// explicitly exercise the unavailable backend, which returns before launch.
const ALLOW: &[(&str, &str)] = &[
    ("open_commands.rs::tests::permission_panes_are_fixed_and_external_guard_is_unchanged", "injected opener and rejected non-HTTP URLs do not invoke an OS opener"),
    ("pty_host_client/exe_origin_tests.rs::windows_lookup::record_less_legacy_host_origin_found_via_connection_pid", "named pipe is served by this test and the sidecar path does not exist"),
    ("pty_host_client/bundle_staging.rs::tests::debug_bare_override_still_installs", "bare fixture bypasses app-bundle signature checking and uses Rust file copying"),
    (
        "tmux_manager.rs::tests::test_spawn_session_unavailable",
        "unavailable backend returns before invoking tmux",
    ),
    (
        "tmux_manager.rs::tests::test_resize_session_unavailable",
        "unavailable backend returns before invoking tmux",
    ),
    (
        "tmux_manager.rs::tests::test_capture_content_unavailable",
        "unavailable backend returns before invoking tmux",
    ),
    (
        "tmux_manager.rs::tests::test_send_input_unavailable",
        "unavailable backend returns before invoking tmux",
    ),
    (
        "tmux_manager.rs::tests::test_send_input_empty_data",
        "empty input returns before invoking tmux",
    ),
    (
        "tmux_manager.rs::tests::test_kill_session_unavailable",
        "unavailable backend returns before invoking tmux",
    ),
    (
        "tmux_manager.rs::tests::test_session_exists_unavailable",
        "unavailable backend returns before invoking tmux",
    ),
    (
        "tmux_manager.rs::tests::test_list_sessions_unavailable",
        "unavailable backend returns before invoking tmux",
    ),
];

fn gate_binding(stmt: &syn::Stmt) -> Option<String> {
    let syn::Stmt::Local(local) = stmt else {
        return None;
    };
    let syn::Pat::Ident(binding) = &local.pat else {
        return None;
    };
    matches!(local.init.as_ref().map(|i| &*i.expr), Some(Expr::Call(c))
        if matches!(&*c.func, Expr::Path(p) if last(&spelling(&p.path)) == "child_process_gate"))
    .then(|| binding.ident.to_string())
}

fn visit_local_macros(calls: &mut Calls, scope: &[&Item]) {
    use proc_macro2::TokenTree;
    let mut visited = BTreeSet::new();
    while let Some(name) = calls
        .macros
        .iter()
        .find(|name| !visited.contains(*name))
        .cloned()
    {
        visited.insert(name.clone());
        for item in scope {
            let Item::Macro(m) = item else { continue };
            if !m.mac.path.is_ident("macro_rules") || !m.ident.as_ref().is_some_and(|i| *i == name)
            {
                continue;
            }
            // At the top level of macro_rules!, `>` is the second half of
            // `=>`. Inspect parseable expansion bodies, not the matchers.
            let mut rhs = false;
            for token in m.mac.tokens.clone() {
                match token {
                    TokenTree::Group(g) if rhs => {
                        if let Ok(block) =
                            syn::parse_str::<syn::Block>(&format!("{{{}}}", g.stream()))
                        {
                            calls.visit_block(&block);
                        }
                        rhs = false;
                    }
                    TokenTree::Punct(p) if p.as_char() == '>' => rhs = true,
                    _ => rhs = false,
                }
            }
        }
    }
}

// Returns (may spawn, has an unguarded spawn). Follow module-local helpers,
// keeping their gate scopes separate from their callers'.
fn effects(
    f: &ItemFn,
    scope: &[&Item],
    aliases: &BTreeMap<String, String>,
    stack: &mut BTreeSet<String>,
) -> (bool, bool) {
    let name = f.sig.ident.to_string();
    if !stack.insert(name.clone()) {
        return (false, false);
    }
    let mut all = Calls {
        imports: aliases.clone(),
        ..Calls::default()
    };
    let scope = f
        .block
        .stmts
        .iter()
        .filter_map(|stmt| match stmt {
            syn::Stmt::Item(item) => Some(item),
            _ => None,
        })
        .chain(scope.iter().copied())
        .collect::<Vec<_>>();
    all.visit_block(&f.block);
    visit_local_macros(&mut all, &scope);
    let expand = |path: &str| {
        let (first, rest) = path.split_once("::").unwrap_or((path, ""));
        match all.imports.get(first) {
            Some(p) if !rest.is_empty() => format!("{p}::{rest}"),
            Some(p) => p.clone(),
            None => path.to_owned(),
        }
    };
    let command = all.paths.iter().map(|p| expand(p)).any(|p| {
        [
            "std::process::Command::new",
            "tokio::process::Command::new",
            "Command::new",
            "build_tmux_command",
        ]
        .contains(&p.as_str())
    });
    let mut guard = None;
    let (mut spawns, mut unguarded) = (false, false);
    for stmt in &f.block.stmts {
        let mut calls = Calls::default();
        calls.visit_stmt(stmt);
        visit_local_macros(&mut calls, &scope);
        let gate = guard.as_ref().is_some_and(|name| !all.drops.contains(name));
        let direct = calls.methods.contains("spawn_command")
            || (command
                && calls
                    .methods
                    .iter()
                    .any(|m| matches!(m.as_str(), "spawn" | "output" | "status")));
        spawns |= direct;
        unguarded |= direct && !gate;
        for path in &calls.paths {
            let path = expand(path);
            let tmux = matches!(
                last(&path),
                "spawn_session"
                    | "resize_session"
                    | "capture_content"
                    | "send_input"
                    | "send_key"
                    | "kill_session"
                    | "session_exists"
                    | "list_sessions"
            ) && (path.contains("tmux_manager::")
                || scope
                    .iter()
                    .any(|i| matches!(i, Item::Fn(h) if h.sig.ident == "build_tmux_command")));
            let starter = tmux || STARTERS.iter().any(|s| ends(&path, s));
            spawns |= starter;
            unguarded |= starter && !gate;
            for item in &scope {
                if let Item::Fn(helper) = item {
                    if helper.sig.ident == last(&path)
                        && (!path.contains("::")
                            || path.starts_with("super::")
                            || path.starts_with("self::"))
                    {
                        let (spawn, missing) = effects(helper, &scope, aliases, stack);
                        spawns |= spawn;
                        unguarded |= missing && !gate;
                    }
                }
            }
        }
        if let Some(name) = gate_binding(stmt) {
            guard = Some(name);
        }
    }
    stack.remove(&name);
    (spawns, unguarded)
}

fn scan(
    items: &[Item],
    parents: &[&Item],
    aliases: &BTreeMap<String, String>,
    prefix: &str,
    hits: &mut Vec<(String, bool)>,
) {
    let mut aliases = aliases.clone();
    for item in items {
        if let Item::Use(u) = item {
            imports(&u.tree, "", &mut aliases);
        }
    }
    let scope = items
        .iter()
        .chain(parents.iter().copied())
        .collect::<Vec<_>>();
    for item in items {
        match item {
            Item::Mod(m) => {
                if let Some((_, items)) = &m.content {
                    scan(
                        items,
                        &scope,
                        &aliases,
                        &format!("{prefix}::{}", m.ident),
                        hits,
                    );
                }
            }
            Item::Fn(f)
                if f.attrs
                    .iter()
                    .any(|a| matches!(spelling(a.path()).as_str(), "test" | "tokio::test")) =>
            {
                let (spawn, missing) = effects(f, &scope, &aliases, &mut BTreeSet::new());
                if spawn {
                    hits.push((format!("{prefix}::{}", f.sig.ident), missing));
                }
            }
            _ => (),
        }
    }
}

fn parse(source: &str, name: &str, hits: &mut Vec<(String, bool)>) {
    // Same line ending normalization as state::source_scan::production, but
    // keep test modules, comments and strings intact for the Rust parser.
    let file =
        syn::parse_file(&source.replace("\r\n", "\n")).unwrap_or_else(|e| panic!("{name}: {e}"));
    scan(&file.items, &[], &BTreeMap::new(), name, hits);
}

fn walk(root: &Path, dir: &Path, hits: &mut Vec<(String, bool)>) {
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
            walk(root, &path, hits);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace(char::from(92), "/");
            parse(&fs::read_to_string(&path).unwrap(), &name, hits);
        }
    }
}

#[test]
fn every_spawning_test_holds_the_gate() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut hits = Vec::new();
    walk(&root, &root, &mut hits);
    hits.sort();
    let missing: Vec<_> = hits
        .iter()
        .filter(|(name, missing)| *missing && !ALLOW.iter().any(|(allowed, _)| name == allowed))
        .map(|(name, _)| name.as_str())
        .collect();
    assert!(
        missing.is_empty(),
        "{} candidates; missing child_process_gate:\n{}",
        hits.len(),
        missing.join("\n")
    );
    assert!(
        hits.len() >= 40,
        "only {} spawning-test candidates",
        hits.len()
    );
    for (allow, reason) in ALLOW {
        assert!(
            hits.iter().any(|(name, missing)| name == allow && *missing),
            "stale allowlist: {allow}: {reason}"
        );
    }
}

#[test]
fn detector_handles_direct_and_indirect_spellings() {
    let source = r#"
        use std::process::{Command as Cmd};
        use tokio::process as async_process;
        fn helper() { assert!(Cmd::new("echo").status().unwrap().success()); }
        #[test] fn alias_in_macro() { helper(); }
        #[test] fn qualified() { ::std::process::Command::new("echo").output(); }
        #[tokio::test] async fn tokio() { let mut cmd = async_process::Command::new("echo"); cmd.spawn(); }
        #[test] fn pty() { pair.slave.spawn_command(builder); }
        #[test] fn starter() { crate::relaunch::spawn_relaunch(); }
        #[test] fn gated() { let _gate = child_process_gate(); helper(); }
        #[test] fn late() { helper(); let _gate = child_process_gate(); }
        #[test] fn wildcard() { let _ = child_process_gate(); helper(); }
        #[test] fn released() { let guard = child_process_gate(); drop(guard); helper(); }
        #[test] fn macro_body() { macro_rules! launch { () => { Cmd::new("echo").status(); }; } launch!(); }
        #[test] fn harmless() { let _ = "Cmd::new().spawn()"; builder.status(); }
    "#;
    let mut hits = Vec::new();
    parse(&source.replace('\n', "\r\n"), "fixture", &mut hits);
    assert_eq!(
        hits.iter()
            .map(|(name, missing)| (last(name), *missing))
            .collect::<Vec<_>>(),
        [
            ("alias_in_macro", true),
            ("qualified", true),
            ("tokio", true),
            ("pty", true),
            ("starter", true),
            ("gated", false),
            ("late", true),
            ("wildcard", true),
            ("released", true),
            ("macro_body", true),
        ]
    );
}
