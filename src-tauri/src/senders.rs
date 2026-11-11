//! Who sends the most mail, and how to stop it: the sender report and unsubscribing
//! (`List-Unsubscribe`, RFC 2369, and one-click, RFC 8058). Reads the cache through
//! `db::messages`; the one-click request is the only network call. Tauri-free.

use crate::db::messages::{self, DbSenderStats};
use crate::gmail::types::Header;
use crate::mail::MailError;
use reqwest::Url;
use serde::Serialize;
use sqlx::SqlitePool;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

/// One sender's mail over the report window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SenderDto {
    pub sender: String,
    pub name: Option<String>,
    pub messages: i64,
    pub unread: i64,
    pub in_inbox: i64,
    pub in_trash: i64,
    pub in_spam: i64,
    /// The inbox tab most of it lands in: primary, promotions, social, updates or forums.
    pub tab: &'static str,
    /// ms since the epoch.
    pub last_date: i64,
    /// Messages the account has ever sent to this address.
    pub you_wrote: i64,
    /// How its newest message offers unsubscribing: `one_click`, `link`, `email`, `none`, or
    /// `unknown` when no message from it has its headers on this computer.
    pub unsubscribe: &'static str,
    /// A conversation with its newest mail, for `unsubscribe`.
    pub thread_id: Option<String>,
}

fn tab(s: &DbSenderStats) -> &'static str {
    let tabbed = s.promotions + s.social + s.updates + s.forums;
    [
        ((s.messages - tabbed).max(0), "primary"),
        (s.promotions, "promotions"),
        (s.social, "social"),
        (s.updates, "updates"),
        (s.forums, "forums"),
    ]
    .into_iter()
    // The first of the largest, so a tie goes to Primary.
    .rev()
    .max_by_key(|(n, _)| *n)
    .map_or("primary", |(_, name)| name)
}

/// The top `limit` senders since `since_ms`, most mail first.
pub async fn report(
    db: &SqlitePool,
    account_id: &str,
    own_address: &str,
    since_ms: i64,
    limit: i64,
) -> Result<Vec<SenderDto>, MailError> {
    let mut out = Vec::new();
    for s in messages::sender_stats(db, account_id, since_ms, own_address, limit).await? {
        let latest = messages::latest_from(db, account_id, &s.address, since_ms).await?;
        let unsubscribe = match latest.as_ref().and_then(|(_, _, h)| h.as_deref()) {
            Some(json) => {
                let headers: Vec<Header> = serde_json::from_str(json).unwrap_or_default();
                options(&headers).kind()
            }
            None => "unknown",
        };
        out.push(SenderDto {
            tab: tab(&s),
            unsubscribe,
            thread_id: latest.map(|(_, thread, _)| thread),
            sender: s.address,
            name: s.name,
            messages: s.messages,
            unread: s.unread,
            in_inbox: s.in_inbox,
            in_trash: s.in_trash,
            in_spam: s.in_spam,
            last_date: s.last_date,
            you_wrote: s.you_wrote,
        });
    }
    Ok(out)
}

/// The ways a message offers to unsubscribe.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UnsubscribeOptions {
    /// An https link that unsubscribes with one POST (RFC 8058).
    pub one_click: Option<String>,
    /// A web page to open (http or https).
    pub web: Option<String>,
    pub mailto: Option<String>,
}

impl UnsubscribeOptions {
    pub fn kind(&self) -> &'static str {
        if self.one_click.is_some() {
            "one_click"
        } else if self.web.is_some() {
            "link"
        } else if self.mailto.is_some() {
            "email"
        } else {
            "none"
        }
    }
}

fn header<'a>(headers: &'a [Header], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

/// The options in a message's `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
pub fn options(headers: &[Header]) -> UnsubscribeOptions {
    let mut out = UnsubscribeOptions::default();
    let Some(list) = header(headers, "List-Unsubscribe") else {
        return out;
    };
    let one_click = header(headers, "List-Unsubscribe-Post").is_some_and(|v| {
        v.replace(' ', "")
            .eq_ignore_ascii_case("List-Unsubscribe=One-Click")
    });
    // `<uri>, <uri>`: commas may appear inside the brackets, so read bracketed parts.
    for part in list.split('<').skip(1) {
        let Some(uri) = part.split('>').next().map(str::trim) else {
            continue;
        };
        let lower = uri.to_ascii_lowercase();
        if lower.starts_with("mailto:") {
            out.mailto.get_or_insert_with(|| uri.to_owned());
        } else if lower.starts_with("https://") {
            if one_click && out.one_click.is_none() {
                out.one_click = Some(uri.to_owned());
            }
            out.web.get_or_insert_with(|| uri.to_owned());
        } else if lower.starts_with("http://") {
            out.web.get_or_insert_with(|| uri.to_owned());
        }
    }
    out
}

/// Whether Pheeme will POST to `url`: https to a named public host. An unsubscribe link comes
/// from whoever sent the mail, so never an IP address or a local name, where it could reach
/// the user's own network.
fn safe_one_click(url: &str) -> Option<Url> {
    let url = Url::parse(url).ok()?;
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return None;
    }
    // `domain()` is `None` for IP addresses.
    let host = url.domain()?;
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let local = !host.contains('.')
        || [
            ".local",
            ".localhost",
            ".internal",
            ".lan",
            ".home",
            ".arpa",
        ]
        .iter()
        .any(|suffix| host.ends_with(suffix));
    (!local).then_some(url)
}

/// Whether an address is on the public internet (not loopback, private, link-local, shared,
/// reserved or the like), so a sender's link can't reach the user's own network.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (18..20).contains(&b))
                || (a == 192 && b == 0))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first == 0x2001 && v6.segments()[1] == 0x0db8))
        }
    }
}

fn not_public() -> MailError {
    MailError::Invalid(
        "Pheeme only unsubscribes in one click through an https link to a public site.".into(),
    )
}

/// Unsubscribe with one POST, as RFC 8058 defines. The host is looked up once and every
/// address must be public; the request goes to those addresses, so a second lookup can't
/// point it elsewhere. Redirects aren't followed.
pub async fn one_click(url: &str) -> Result<(), MailError> {
    let Some(url) = safe_one_click(url) else {
        return Err(not_public());
    };
    let host = url.host_str().unwrap_or_default().to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| MailError::Invalid(format!("Couldn't find the sender's site: {e}")))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
        return Err(not_public());
    }
    let client = crate::http::client_builder()
        .resolve_to_addrs(&host, &addrs)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| MailError::Invalid(format!("Couldn't unsubscribe: {e}")))?;
    let response = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("List-Unsubscribe=One-Click")
        .send()
        .await
        .map_err(|e| {
            MailError::Invalid(format!("Couldn't reach the sender to unsubscribe: {e}"))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(MailError::Invalid(format!(
            "The sender's unsubscribe link answered {status}, so it may not have worked. Give the user the link."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(name: &str, value: &str) -> Header {
        Header {
            name: name.into(),
            value: value.into(),
        }
    }

    #[test]
    fn reads_unsubscribe_headers() {
        let both = [
            h(
                "List-Unsubscribe",
                "<mailto:leave@x.com?subject=bye>, <https://x.com/u?a=1,2>",
            ),
            h("list-unsubscribe-post", "List-Unsubscribe=One-Click"),
        ];
        let o = options(&both);
        assert_eq!(o.one_click.as_deref(), Some("https://x.com/u?a=1,2"));
        assert_eq!(o.mailto.as_deref(), Some("mailto:leave@x.com?subject=bye"));
        assert_eq!(o.kind(), "one_click");

        let web = options(&[h("List-Unsubscribe", "<http://x.com/u>")]);
        assert_eq!(
            (web.one_click, web.web.as_deref()),
            (None, Some("http://x.com/u"))
        );
        // One-click needs https.
        let plain = options(&[
            h("List-Unsubscribe", "<http://x.com/u>"),
            h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
        ]);
        assert_eq!(plain.kind(), "link");
        assert_eq!(
            options(&[h("List-Unsubscribe", "<mailto:a@x.com>")]).kind(),
            "email"
        );
        assert_eq!(options(&[h("Subject", "hi")]).kind(), "none");
    }

    #[test]
    fn one_click_only_goes_to_public_https_hosts() {
        assert!(safe_one_click("https://mail.example.com/u?x=1").is_some());
        for bad in [
            "http://example.com/u",
            "https://127.0.0.1/u",
            "https://[::1]/u",
            "https://10.0.0.1/u",
            "https://localhost/u",
            "https://router/u",
            "https://printer.local/u",
            "https://a.internal/u",
            "https://user:pw@example.com/u",
            "not a url",
        ] {
            assert!(safe_one_click(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn only_public_addresses_pass() {
        for public in ["8.8.8.8", "1.1.1.1", "2606:4700::1111"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "198.18.0.1",
            "240.0.0.1",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.1.1",
            "2001:db8::1",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
    }

    #[test]
    fn the_tab_is_where_most_of_it_lands() {
        let stats = |messages, promotions, social, updates| DbSenderStats {
            address: "a@x.com".into(),
            name: None,
            messages,
            unread: 0,
            in_inbox: 0,
            in_trash: 0,
            in_spam: 0,
            promotions,
            social,
            updates,
            forums: 0,
            last_date: 0,
            you_wrote: 0,
        };
        assert_eq!(tab(&stats(10, 4, 3, 3)), "promotions");
        assert_eq!(tab(&stats(10, 0, 0, 2)), "primary");
        assert_eq!(tab(&stats(4, 2, 0, 0)), "primary");
    }

    #[tokio::test]
    async fn refuses_unsafe_links_without_a_request() {
        let err = one_click("https://192.168.1.1/u").await.unwrap_err();
        assert!(err.to_string().contains("https link"), "{err}");
    }
}
