//! Spell checking in text fields (the compose body, subjects, notes). WebKit leaves it off unless the app turns it
//! on: WKWebView checks while typing only when the app's `WebContinuousSpellCheckingEnabled` default is true (unset
//! means off; Safari sets it for itself), and a WebKitGTK web context starts with it disabled and no dictionaries.
//! WebView2 on Windows already checks spelling.

/// macOS: make "check spelling while typing" default to on. A registered default sits below anything stored in the
/// app's own defaults, so it never overrides a choice made elsewhere. WebKit reads the key once, when the first
/// webview starts, so this must run before any window is created.
#[cfg(target_os = "macos")]
pub fn enable_before_webviews() {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    let key = NSString::from_str("WebContinuousSpellCheckingEnabled");
    let on = NSNumber::new_bool(true);
    let on: &AnyObject = &on;
    let defaults = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[on]);
    // SAFETY: the dictionary's keys are strings, as `registerDefaults:` expects.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&defaults) };
}

/// Linux: turn spell checking on in the window's web context, with the user's locales as its languages. WebKitGTK
/// needs a language list before it loads any dictionary; locales without an installed dictionary are skipped.
#[cfg(target_os = "linux")]
pub fn enable_in(window: &tauri::WebviewWindow) {
    use webkit2gtk::{WebContextExt, WebViewExt};

    let languages = locale_languages(
        webkit2gtk::glib::language_names()
            .iter()
            .map(|s| s.as_str()),
    );
    let result = window.with_webview(move |webview| {
        let Some(context) = webview.inner().context() else {
            tracing::warn!("webview has no web context; spell checking stays off");
            return;
        };
        let languages: Vec<&str> = languages.iter().map(String::as_str).collect();
        context.set_spell_checking_languages(&languages);
        context.set_spell_checking_enabled(true);
        // The languages WebKit found a dictionary for; empty means nothing gets checked.
        let loaded = context.spell_checking_languages();
        tracing::info!(requested = ?languages, ?loaded, "spell checking on");
    });
    if let Err(err) = result {
        tracing::warn!("couldn't turn on spell checking: {err}");
    }
}

/// The spelling languages for a list of POSIX locale names (`en_US.UTF-8`, `de_DE@euro`, `C`): each without its
/// codeset or modifier, in order, once, leaving out the `C` and `POSIX` locales.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn locale_languages<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut languages: Vec<String> = Vec::new();
    for name in names {
        let language = name.split(['.', '@']).next().unwrap_or_default();
        if language.is_empty() || language == "C" || language == "POSIX" {
            continue;
        }
        if !languages.iter().any(|seen| seen == language) {
            languages.push(language.to_owned());
        }
    }
    languages
}

#[cfg(test)]
mod tests {
    use super::locale_languages;

    #[test]
    fn locale_names_become_spelling_languages() {
        let names = [
            "en_US.UTF-8",
            "en_US",
            "en.UTF-8",
            "en",
            "de_DE@euro",
            "C.UTF-8",
            "C",
            "POSIX",
        ];
        assert_eq!(locale_languages(names), ["en_US", "en", "de_DE"]);
    }
}
