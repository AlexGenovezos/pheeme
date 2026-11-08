//! HTTP clients. reqwest is built without a TLS crypto provider (to avoid compiling a second
//! one), so it panics if a client is built before one is installed. Every client starts here,
//! which installs ring, the provider the updater plugin also picks. Clippy rejects
//! `reqwest::Client::new`, `reqwest::Client::builder` and `reqwest::get` (see `clippy.toml`).

use std::sync::Once;

/// A `reqwest::ClientBuilder`, with the TLS provider installed.
#[allow(clippy::disallowed_methods)]
pub fn client_builder() -> reqwest::ClientBuilder {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        // Err means a provider is already installed, which is all we need.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    reqwest::Client::builder()
}

/// A client with reqwest's defaults (no timeout).
pub fn client() -> reqwest::Client {
    client_builder()
        .build()
        .expect("reqwest client builds with default config")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clients_build_and_the_provider_is_installed() {
        let _ = client();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    /// Needs the network: the OS verifier accepts Google's certificates, and a bad one fails.
    /// `cargo test -- --ignored https_uses_the_os_certificate_verifier`
    #[tokio::test]
    #[ignore]
    async fn https_uses_the_os_certificate_verifier() {
        for url in [
            "https://oauth2.googleapis.com/",
            "https://gmail.googleapis.com/",
        ] {
            let response = client().get(url).send().await;
            assert!(response.is_ok(), "{url}: {response:?}");
        }
        let bad = client().get("https://expired.badssl.com/").send().await;
        assert!(bad.is_err(), "an expired certificate was accepted");
    }
}
