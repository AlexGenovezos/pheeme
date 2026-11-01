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

    fn security() -> serde_json::Value {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        conf["app"]["security"].clone()
    }

    #[test]
    fn csp_is_strict() {
        let sec = security();
        let csp = sec["csp"].as_object().expect("csp must be an object");
        assert_eq!(csp["default-src"], "'self'");
        assert_eq!(csp["script-src"], "'self'");
        for (directive, value) in csp {
            let value = value.as_str().unwrap();
            assert!(!value.contains("unsafe-eval"), "{directive} allows eval");
            if directive != "style-src" {
                assert!(
                    !value.contains("unsafe-inline"),
                    "{directive} allows unsafe-inline"
                );
            }
        }
    }

    #[test]
    fn dev_csp_allows_vite_but_never_eval() {
        let sec = security();
        let dev = sec["devCsp"].as_object().expect("devCsp must be an object");
        assert_eq!(dev["default-src"], "'self'");
        assert_eq!(dev["script-src"], "'self' 'unsafe-inline'");
        let connect = dev["connect-src"].as_str().unwrap();
        assert!(connect.contains("ws://localhost:1420"));
        assert!(connect.contains("ws://localhost:1421"));
        for (directive, value) in dev {
            assert!(
                !value.as_str().unwrap().contains("unsafe-eval"),
                "{directive} allows eval"
            );
        }
    }
}
