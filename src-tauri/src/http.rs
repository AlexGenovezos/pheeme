//! HTTP clients. reqwest is built without a TLS crypto provider (to avoid compiling a second
//! one), so it panics if a client is built before one is installed. Every client starts here,
//! which installs ring, the provider the updater plugin also picks. Clippy rejects
//! `reqwest::Client::new`, `reqwest::Client::builder` and `reqwest::get` (see `clippy.toml`).

use std::net::IpAddr;
use std::sync::{Once, OnceLock};
use std::time::Duration;

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

/// One connection pool for Gmail, Calendar, Tasks and People API requests.
pub(crate) fn google_api_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            client_builder()
                .timeout(Duration::from_secs(30))
                .user_agent(concat!("pheeme/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("reqwest client with static configuration builds")
        })
        .clone()
}

/// Whether `ip` is a unicast address reachable across the internet (what the unstable
/// `IpAddr::is_global` decides): not private, shared (carrier-grade NAT, also used by VPNs like
/// Tailscale), loopback, link-local, multicast, documentation, benchmarking or reserved. The one
/// rule for every request whose address comes from someone else (mail, mods), so a link can't
/// reach the user's own network.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0 // "this network"
                || a >= 240 // reserved and broadcast
                || (a == 100 && (b & 0xc0) == 64) // shared address space, 100.64.0.0/10
                || (a == 192 && b == 0 && c == 0) // protocol assignments
                || (a == 192 && b == 88 && c == 99) // 6to4 relay anycast
                || (a == 198 && (b & 0xfe) == 18)) // benchmarking, 198.18.0.0/15
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let [first, second, ..] = v6.segments();
            // Global unicast is 2000::/3; everything else (loopback, IPv4-compatible ::/96,
            // NAT64 64:ff9b::/96, discard 100::/64, unique local, site-local, link-local,
            // multicast) stays off. Inside it, the special-purpose blocks that aren't globally
            // reachable stay off too, whole: IETF protocol assignments (2001::/23, which holds
            // benchmarking), 6to4 (2002::/16, which can wrap a private IPv4 address),
            // documentation (2001:db8::/32, 3fff::/20) and segment routing (5f00::/16).
            (first & 0xe000) == 0x2000
                && !(first == 0x2001 && second < 0x0200)
                && !(first == 0x2001 && second == 0x0db8)
                && first != 0x2002
                && (first & 0xfff0) != 0x3ff0
                && first != 0x5f00
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clients_build_and_the_provider_is_installed() {
        let _ = client();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn only_global_unicast_addresses_are_public() {
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450::1"] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "198.18.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "240.0.0.1",
            "224.0.0.1",
            "::1",
            "::",
            "::7f00:1",
            "64:ff9b::7f00:1",
            "100::1",
            "fd00::1",
            "fec0::1",
            "fe80::1",
            "ff02::1",
            "::ffff:192.168.1.1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
            "5f00::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
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
