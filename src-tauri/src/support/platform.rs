//! Which system the report came from: the OS version and the webview drawing the window. On a Mac
//! the window is the system's WebKit, which comes with Safari, so what the window can run (a
//! JavaScript built-in pdf.js calls, say) follows the Safari version, not Pheeme's.

use serde::Serialize;

/// The webview's versions, where the system says them.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Webview {
    /// Safari's version (`26.1`): the one Apple's release notes name features by.
    pub safari: Option<String>,
    /// WebKit's build (`20622.2.11.119.1`), for telling apart updates within one Safari version.
    pub webkit: Option<String>,
}

/// `15.6.1` on a Mac; None elsewhere.
pub fn os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let v = objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion();
        Some(format!(
            "{}.{}.{}",
            v.majorVersion, v.minorVersion, v.patchVersion
        ))
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// The Mac's Safari and WebKit versions; None elsewhere.
pub fn webview() -> Option<Webview> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{ns_string, NSBundle, NSString};
        let info = |bundle: Option<objc2::rc::Retained<NSBundle>>, key: &NSString| {
            bundle?
                .objectForInfoDictionaryKey(key)?
                .downcast::<NSString>()
                .ok()
                .map(|s| s.to_string())
        };
        Some(Webview {
            safari: info(
                NSBundle::bundleWithPath(ns_string!("/Applications/Safari.app")),
                ns_string!("CFBundleShortVersionString"),
            ),
            // The WebKit loaded in this process: the one the window runs.
            webkit: info(
                NSBundle::bundleWithIdentifier(ns_string!("com.apple.WebKit")),
                ns_string!("CFBundleVersion"),
            ),
        })
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn a_mac_names_its_version_and_webview() {
        let os = os_version().unwrap();
        assert_eq!(os.split('.').count(), 3, "{os}");
        let webview = webview().unwrap();
        // Every Mac has Safari; the test binary hasn't loaded WebKit, but the system knows it.
        assert!(webview.safari.is_some(), "{webview:?}");
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn elsewhere_says_nothing() {
        assert_eq!(os_version(), None);
        assert_eq!(webview(), None);
    }
}
