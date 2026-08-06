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

#[cfg(test)]
mod tests {
    use super::*;

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
