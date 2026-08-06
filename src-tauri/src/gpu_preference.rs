//! Windows-only: translate the OS per-app graphics preference set on TermFlow's
//! own executable into a Chromium GPU-selection switch for WebView2.
//!
//! Windows keys `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` on the image
//! path of the process that creates the D3D device, and does not inherit it to
//! child processes. TermFlow never creates that device -- WebView2's GPU process is
//! a separate `msedgewebview2.exe` -- so the setting never reaches the renderer on
//! its own. We read it here and pass the equivalent switch as a browser argument.
//!
//! See termflow-fabric/docs/design/008-webview2-gpu-preference-design.md.

/// wry's default browser arguments. Setting `additional_browser_args` REPLACES
/// this list rather than extending it, so it must be restated verbatim.
/// Sync source: `wry-0.53.5/src/webview2/mod.rs:297` -- re-check on a wry upgrade.
#[cfg(any(windows, test))]
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

#[cfg(any(windows, test))]
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::OnceLock;

#[cfg(any(windows, test))]
const FORCE_HIGH: &str = "--force_high_performance_gpu";
#[cfg(any(windows, test))]
const FORCE_LOW: &str = "--force_low_power_gpu";

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Preference {
    High,
    Low,
    /// A valid `GpuPreference=0` -- the user's explicit "Let Windows decide".
    /// A real decision (it ends the candidate search) that takes the default switch.
    WindowsDefault,
    /// The entry says nothing about GPU selection: absent, malformed, or carrying
    /// only unrelated DirectX fields. NOT a decision -- keep searching.
    NoPreference,
}

#[cfg(any(windows, test))]
impl Preference {
    fn switch(self) -> &'static str {
        match self {
            Preference::Low => FORCE_LOW,
            // High, WindowsDefault and NoPreference all take the default (design 008).
            _ => FORCE_HIGH,
        }
    }

    /// True when this value settles the question, so the candidate search stops.
    fn is_decision(self) -> bool {
        !matches!(self, Preference::NoPreference)
    }
}

/// Split a `UserGpuPreferences` value into `k=v` pairs and return the value of
/// `key`, case-insensitively. Unrelated fields are ignored.
#[cfg(any(windows, test))]
fn field<'a>(value: &'a str, key: &str) -> Option<&'a str> {
    value.split(';').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        k.trim().eq_ignore_ascii_case(key).then_some(v.trim())
    })
}

/// Interpret the `GpuPreference` field alone. `1073741824` is the
/// "see SpecificAdapter" marker and is not a preference in itself.
#[cfg(any(windows, test))]
fn parse_gpu_preference(value: &str) -> Preference {
    match field(value, "GpuPreference") {
        Some("2") => Preference::High,
        Some("1") => Preference::Low,
        Some("0") => Preference::WindowsDefault,
        _ => Preference::NoPreference,
    }
}

/// Paths the preference may have been registered against, most specific first.
///
/// A Velopack install carries the binary at both `…\TermFlow\current\termflow.exe`
/// and the stub `…\TermFlow\termflow.exe`, and the Windows Settings UI records
/// whichever one the user browsed to -- checking only one would miss half the cases.
///
/// `is_velopack` must come from an actual layout check, not from the directory
/// merely being named `current`; otherwise an unrelated `…\current\termflow.exe`
/// would read a stranger's sibling entry.
#[cfg(any(windows, test))]
fn candidate_paths(exe: &Path, is_velopack: bool) -> Vec<PathBuf> {
    let mut paths = vec![exe.to_path_buf()];

    if is_velopack {
        if let (Some(parent), Some(file_name)) = (exe.parent(), exe.file_name()) {
            if let Some(root) = parent.parent() {
                let stub = root.join(file_name);
                if stub != exe {
                    paths.push(stub);
                }
            }
        }
    }

    paths
}

/// The identity Windows records for an explicitly chosen adapter:
/// `SpecificAdapter=<vendor>&<device>&<subsystem>`, all hex.
#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AdapterId {
    vendor: u32,
    device: u32,
    subsys: u32,
}

#[cfg(any(windows, test))]
fn parse_adapter(s: &str) -> Option<AdapterId> {
    let mut parts = s.split('&');
    let vendor = u32::from_str_radix(parts.next()?.trim(), 16).ok()?;
    let device = u32::from_str_radix(parts.next()?.trim(), 16).ok()?;
    let subsys = u32::from_str_radix(parts.next()?.trim(), 16).ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(AdapterId {
        vendor,
        device,
        subsys,
    })
}

/// Reduce a registry value to a preference class.
///
/// `resolve` answers "is this adapter the high-performance one on this machine?"
/// It is a parameter so the parser stays pure and testable off Windows; the DXGI
/// implementation lives in `resolve_adapter`.
///
/// PCI vendor id deliberately plays no part. Vendor identifies the manufacturer,
/// not the power class -- an AMD iGPU beside an NVIDIA dGPU, or an Intel Arc dGPU
/// beside an Intel iGPU, both invert under a vendor table (design 008).
#[cfg(any(windows, test))]
fn parse_with(value: &str, resolve: impl Fn(AdapterId) -> Option<Preference>) -> Preference {
    let explicit = parse_gpu_preference(value);

    if let Some(adapter) = field(value, "SpecificAdapter") {
        if let Some(resolved) = parse_adapter(adapter).and_then(resolve) {
            return resolved;
        }
        // Unparseable, or an adapter this machine no longer has: fall back to a
        // usable GpuPreference in the same value rather than discarding it.
    }

    explicit
}

/// Ask the system which adapter is actually its high-performance one, and report
/// whether `requested` is that adapter.
///
/// Returns `None` when DXGI is unavailable or `requested` matches no present
/// adapter (a stale entry for a GPU since removed), so the caller can fall back.
#[cfg(windows)]
fn resolve_adapter(requested: AdapterId) -> Option<Preference> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIFactory6, DXGI_ADAPTER_DESC1,
        DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
    };

    fn matches(desc: &DXGI_ADAPTER_DESC1, id: AdapterId) -> bool {
        desc.VendorId == id.vendor && desc.DeviceId == id.device && desc.SubSysId == id.subsys
    }

    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let factory6: IDXGIFactory6 = factory.cast().ok()?;

        // The machine's high-performance adapter, per the OS itself. This is the
        // whole point: vendor id cannot tell us this, but DXGI can.
        let high: IDXGIAdapter1 = factory6
            .EnumAdapterByGpuPreference(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)
            .ok()?;
        if matches(&high.GetDesc1().ok()?, requested) {
            return Some(Preference::High);
        }

        // Not the high-performance one. Confirm it is present at all before
        // calling it low power -- a stale entry must fall back, not force the iGPU.
        for index in 0u32.. {
            let Ok(adapter) = factory.EnumAdapters1(index) else {
                break;
            };
            // A descriptor we cannot read tells us nothing about THIS adapter;
            // skip it rather than abandoning the whole search.
            if let Ok(desc) = adapter.GetDesc1() {
                if matches(&desc, requested) {
                    return Some(Preference::Low);
                }
            }
        }

        None
    }
}

/// Walk the candidates and return the first that actually expresses a GPU
/// decision. A readable entry that says nothing about GPU selection, or a read
/// that fails, must not mask a real preference on a later candidate.
#[cfg(any(windows, test))]
fn search(candidates: &[PathBuf], read: impl Fn(&Path) -> Option<String>) -> Preference {
    for path in candidates {
        let Some(value) = read(path) else { continue };

        #[cfg(windows)]
        let preference = parse_with(&value, resolve_adapter);
        #[cfg(not(windows))]
        let preference = parse_with(&value, |_| None);

        if preference.is_decision() {
            log::info!(
                "gpu_preference: resolved {preference:?} from {}",
                path.display()
            );
            return preference;
        }
    }
    Preference::NoPreference
}

#[cfg(windows)]
const REG_PATH: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";

#[cfg(windows)]
fn read_registry(path: &Path) -> Option<String> {
    let key = windows_registry::CURRENT_USER.open(REG_PATH).ok()?;
    key.get_string(path.to_str()?).ok()
}

#[cfg(windows)]
fn resolve() -> Preference {
    let Ok(exe) = std::env::current_exe() else {
        log::info!("gpu_preference: current_exe() unavailable; using the default");
        return Preference::NoPreference;
    };

    let candidates = candidate_paths(&exe, crate::native_notify::is_velopack_install());
    let preference = search(&candidates, read_registry);

    if !preference.is_decision() {
        log::info!(
            "gpu_preference: no OS graphics preference registered for {}; defaulting to high performance",
            exe.display()
        );
    }
    preference
}

/// Browser arguments for every webview in this process.
///
/// INVARIANT: every webview creation site must pass this exact string. WebView2
/// environments sharing a user data folder must agree on
/// `AdditionalBrowserArguments`; a mismatch fails creation with
/// `ERROR_INVALID_STATE` (0x8007139F) and the window does not open. The `OnceLock`
/// is what guarantees one value -- resolution happens once, every caller gets it.
#[cfg(windows)]
pub fn browser_args() -> &'static str {
    static ARGS: OnceLock<String> = OnceLock::new();
    ARGS.get_or_init(|| format!("{WRY_DEFAULT_ARGS} {}", resolve().switch()))
}

#[cfg(windows)]
fn apply_to_windows(windows: &mut [tauri::utils::config::WindowConfig]) {
    for window in windows.iter_mut() {
        window.additional_browser_args = Some(browser_args().to_string());
    }
}

/// Stamp the resolved browser arguments onto every window declared in
/// `tauri.conf.json`, before Tauri creates them.
///
/// Tauri builds config-declared windows *before* the app's `setup` closure runs
/// (`tauri-2.9.5/src/app.rs:2375`), so this cannot be done from `setup` -- by then
/// the main window's WebView2 environment already exists.
#[cfg(windows)]
pub fn apply_to_context<R: tauri::Runtime>(mut context: tauri::Context<R>) -> tauri::Context<R> {
    apply_to_windows(&mut context.config_mut().app.windows);
    context
}

/// No-op passthrough: GPU selection via browser arguments is Windows-only.
#[cfg(not(windows))]
pub fn apply_to_context<R: tauri::Runtime>(context: tauri::Context<R>) -> tauri::Context<R> {
    context
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[cfg(windows)]
    #[test]
    fn every_config_window_gets_the_identical_argument_string() {
        use tauri::utils::config::WindowConfig;

        let mut windows = vec![WindowConfig::default(), WindowConfig::default()];
        apply_to_windows(&mut windows);

        assert_eq!(
            windows[0].additional_browser_args, windows[1].additional_browser_args,
            "all windows must receive a byte-identical string"
        );
        assert_eq!(
            windows[0].additional_browser_args.as_deref(),
            Some(browser_args())
        );
    }

    #[cfg(windows)]
    #[test]
    fn applying_to_an_empty_window_list_is_harmless() {
        let mut windows: Vec<tauri::utils::config::WindowConfig> = vec![];
        apply_to_windows(&mut windows);
        assert!(windows.is_empty());
    }

    #[test]
    fn an_entry_without_a_gpu_field_does_not_mask_the_next_candidate() {
        let first = PathBuf::from("a.exe");
        let second = PathBuf::from("b.exe");
        let candidates = vec![first.clone(), second];
        let read = |p: &Path| {
            if p == first {
                Some("AutoHDREnable=1;".to_string())
            } else {
                Some("GpuPreference=1;".to_string())
            }
        };
        assert_eq!(search(&candidates, read), Preference::Low);
    }

    #[test]
    fn a_failed_read_does_not_mask_the_next_candidate() {
        let first = PathBuf::from("a.exe");
        let second = PathBuf::from("b.exe");
        let candidates = vec![first.clone(), second];
        let read = |p: &Path| {
            if p == first {
                None
            } else {
                Some("GpuPreference=1;".to_string())
            }
        };
        assert_eq!(search(&candidates, read), Preference::Low);
    }

    #[test]
    fn let_windows_decide_on_the_first_candidate_stops_the_search() {
        let first = PathBuf::from("a.exe");
        let second = PathBuf::from("b.exe");
        let candidates = vec![first.clone(), second];
        let read = |p: &Path| {
            if p == first {
                Some("GpuPreference=0;".to_string())
            } else {
                Some("GpuPreference=1;".to_string())
            }
        };
        assert_eq!(search(&candidates, read), Preference::WindowsDefault);
    }

    #[test]
    fn exhausting_every_candidate_expresses_nothing() {
        let candidates = vec![PathBuf::from("a.exe")];
        assert_eq!(search(&candidates, |_| None), Preference::NoPreference);
    }

    #[cfg(windows)]
    #[test]
    fn browser_args_preserve_wry_defaults_and_add_exactly_one_switch() {
        let args = browser_args();
        assert!(args.starts_with(WRY_DEFAULT_ARGS), "got: {args}");
        assert_eq!(args.matches("--force_").count(), 1, "got: {args}");
    }

    #[cfg(windows)]
    #[test]
    fn every_call_returns_equal_content() {
        // The real WebView2 requirement is content equality across all four
        // creation sites; pointer identity is a supporting detail, not the contract.
        assert_eq!(browser_args(), browser_args());
    }

    #[test]
    fn velopack_install_also_checks_the_stub_path() {
        let root = PathBuf::from("TermFlow");
        let exe = root.join("current").join("termflow.exe");
        let paths = candidate_paths(&exe, true);
        assert_eq!(paths, vec![exe.clone(), root.join("termflow.exe")]);
    }

    #[test]
    fn a_non_velopack_current_directory_yields_one_candidate() {
        // A stranger's directory that merely happens to be named `current` must
        // not cause us to read their sibling registry entry.
        let exe = PathBuf::from("unrelated").join("current").join("termflow.exe");
        assert_eq!(candidate_paths(&exe, false), vec![exe]);
    }

    #[test]
    fn dev_build_yields_a_single_candidate() {
        let exe = PathBuf::from("target").join("debug").join("termflow-app.exe");
        assert_eq!(candidate_paths(&exe, false), vec![exe]);
    }

    #[test]
    fn a_bare_filename_is_safe() {
        let exe = PathBuf::from("termflow.exe");
        assert_eq!(candidate_paths(&exe, true), vec![exe]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_root_is_safe() {
        let exe = PathBuf::from(r"C:\termflow.exe");
        assert_eq!(candidate_paths(&exe, true), vec![exe]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_unc_velopack_path_derives_the_stub() {
        let exe = PathBuf::from(r"\\server\share\TermFlow\current\termflow.exe");
        let paths = candidate_paths(&exe, true);
        assert_eq!(paths.len(), 2);
        assert_eq!(
            paths[1],
            PathBuf::from(r"\\server\share\TermFlow\termflow.exe")
        );
    }

    // Stub resolvers standing in for DXGI.
    fn never_resolves(_: AdapterId) -> Option<Preference> {
        None
    }
    fn always_high(_: AdapterId) -> Option<Preference> {
        Some(Preference::High)
    }
    fn always_low(_: AdapterId) -> Option<Preference> {
        Some(Preference::Low)
    }

    #[test]
    fn adapter_triple_parses_case_insensitively() {
        assert_eq!(
            parse_adapter("10DE&2544&88A81043"),
            Some(AdapterId {
                vendor: 0x10DE,
                device: 0x2544,
                subsys: 0x88A8_1043
            })
        );
        assert_eq!(
            parse_adapter("10de&2544&88a81043"),
            Some(AdapterId {
                vendor: 0x10DE,
                device: 0x2544,
                subsys: 0x88A8_1043
            })
        );
    }

    #[test]
    fn malformed_adapter_triples_are_rejected() {
        assert_eq!(parse_adapter(""), None);
        assert_eq!(parse_adapter("10DE"), None);
        assert_eq!(parse_adapter("10DE&2544"), None);
        assert_eq!(parse_adapter("ZZZZ&2544&88A81043"), None);
    }

    #[test]
    fn the_resolver_decides_the_specific_adapter_form() {
        let value = "SpecificAdapter=10DE&2544&88A81043;GpuPreference=1073741824;";
        assert_eq!(parse_with(value, always_high), Preference::High);
        assert_eq!(parse_with(value, always_low), Preference::Low);
    }

    #[test]
    fn vendor_id_alone_never_decides() {
        // The regression this whole task exists for: an AMD iGPU on an
        // AMD-APU + NVIDIA-dGPU laptop must NOT be read as high performance.
        let amd = "SpecificAdapter=1002&164E&00000000;GpuPreference=1073741824;";
        assert_eq!(parse_with(amd, always_low), Preference::Low);
        // And an Intel Arc dGPU must NOT be read as low power.
        let arc = "SpecificAdapter=8086&56A0&00000000;GpuPreference=1073741824;";
        assert_eq!(parse_with(arc, always_high), Preference::High);
    }

    #[test]
    fn unresolvable_adapter_falls_back_to_a_valid_gpu_preference() {
        // A stale entry for a removed GPU, or an empty adapter field, must not
        // discard a usable GpuPreference sitting in the same value.
        assert_eq!(
            parse_with("SpecificAdapter=;GpuPreference=1;", never_resolves),
            Preference::Low
        );
        assert_eq!(
            parse_with(
                "SpecificAdapter=BEEF&0000&00000000;GpuPreference=1;",
                never_resolves
            ),
            Preference::Low
        );
    }

    #[test]
    fn unresolvable_adapter_with_no_fallback_expresses_nothing() {
        assert_eq!(
            parse_with(
                "SpecificAdapter=BEEF&0000&00000000;GpuPreference=1073741824;",
                never_resolves
            ),
            Preference::NoPreference
        );
    }

    #[test]
    fn values_without_an_adapter_never_call_the_resolver() {
        fn explodes(_: AdapterId) -> Option<Preference> {
            panic!("resolver must not run when no SpecificAdapter is present")
        }
        assert_eq!(parse_with("GpuPreference=2;", explodes), Preference::High);
        assert_eq!(
            parse_with("AutoHDREnable=1;", explodes),
            Preference::NoPreference
        );
    }

    #[test]
    fn explicit_high_and_low() {
        assert_eq!(parse_gpu_preference("GpuPreference=2;"), Preference::High);
        assert_eq!(parse_gpu_preference("GpuPreference=1;"), Preference::Low);
    }

    #[test]
    fn let_windows_decide_is_a_real_choice() {
        assert_eq!(
            parse_gpu_preference("GpuPreference=0;"),
            Preference::WindowsDefault
        );
    }

    #[test]
    fn missing_trailing_semicolon_still_parses() {
        assert_eq!(parse_gpu_preference("GpuPreference=2"), Preference::High);
    }

    #[test]
    fn entries_without_a_gpu_field_express_nothing() {
        // Windows co-locates other per-app DirectX fields under the same key.
        // These are entries, but they are not GPU decisions.
        assert_eq!(
            parse_gpu_preference("AutoHDREnable=1;"),
            Preference::NoPreference
        );
        assert_eq!(
            parse_gpu_preference("SwapEffectUpgradeEnable=0;"),
            Preference::NoPreference
        );
        assert_eq!(parse_gpu_preference(""), Preference::NoPreference);
        assert_eq!(parse_gpu_preference("nonsense"), Preference::NoPreference);
        assert_eq!(
            parse_gpu_preference("GpuPreference=;"),
            Preference::NoPreference
        );
    }

    #[test]
    fn the_specific_adapter_marker_alone_expresses_nothing() {
        // 1073741824 means "see SpecificAdapter", not a preference in itself.
        assert_eq!(
            parse_gpu_preference("GpuPreference=1073741824;"),
            Preference::NoPreference
        );
    }

    #[test]
    fn unrelated_fields_do_not_disturb_a_valid_one() {
        assert_eq!(
            parse_gpu_preference("AutoHDREnable=1;GpuPreference=1;"),
            Preference::Low
        );
        assert_eq!(
            parse_gpu_preference("GpuPreference=1;AutoHDREnable=1;"),
            Preference::Low
        );
    }

    #[test]
    fn only_no_preference_continues_the_search() {
        assert!(Preference::High.is_decision());
        assert!(Preference::Low.is_decision());
        assert!(Preference::WindowsDefault.is_decision());
        assert!(!Preference::NoPreference.is_decision());
    }

    #[test]
    fn windows_default_and_no_preference_both_take_the_high_switch() {
        assert_eq!(Preference::High.switch(), FORCE_HIGH);
        assert_eq!(Preference::WindowsDefault.switch(), FORCE_HIGH);
        assert_eq!(Preference::NoPreference.switch(), FORCE_HIGH);
        assert_eq!(Preference::Low.switch(), FORCE_LOW);
    }
}
