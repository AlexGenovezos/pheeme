//! Single source of truth for the app identity. The bundle identifier drives the
//! app-data directory, keychain service name and updater identity, so it must
//! never change once a build has shipped.

/// Must match `identifier` in `tauri.conf.json` (enforced by a test).
pub const APP_IDENTIFIER: &str = "app.pheeme.desktop";

/// Service name for all OS keychain entries.
pub const KEYCHAIN_SERVICE: &str = APP_IDENTIFIER;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_IDENTIFIER);
        assert_eq!(conf["productName"], "Pheeme");
    }

    #[test]
    fn csp_is_strict() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = &conf["app"]["security"]["csp"];
        assert!(!csp.is_null(), "CSP must be set");
        let s = csp.to_string();
        assert!(s.contains("default-src") && s.contains("'self'"));
        assert!(!s.contains("unsafe-eval"));
        assert!(!s.contains("script-src 'self' 'unsafe-inline'"));
    }
}
