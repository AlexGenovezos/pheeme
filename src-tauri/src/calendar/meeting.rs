//! Video meeting links: the one place that decides which link joins an event's call (Google
//! Meet, Zoom, Microsoft Teams, Webex, …). Calendar events (the badge, the popover's Join,
//! reminder notifications) and the invitations emails carry (Mail's invite card) both ask here.
//!
//! An event's own conference (Google's `conferenceData`, `hangoutLink`, an invitation's
//! `CONFERENCE` lines) is taken as it is, whatever the provider. Otherwise the first link in
//! the location, then the description, that a provider below would use to join a call: their
//! other links (Zoom's "find your local number", Teams' meeting options, help pages) don't count.

use crate::db::calendar::DbEvent;
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;

/// A link that joins a video call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingLink {
    pub url: String,
    /// "Zoom", "Microsoft Teams", …; `None` for a conference from a provider not listed here.
    pub provider: Option<String>,
}

struct Provider {
    name: &'static str,
    /// The host or any subdomain of it (`us02web.zoom.us`, `acme.webex.com`).
    hosts: &'static [&'static str],
    /// Pieces of the path only join links have (lowercase). Empty: any path but `/`.
    paths: &'static [&'static str],
}

const PROVIDERS: &[Provider] = &[
    Provider {
        name: "Google Meet",
        hosts: &["meet.google.com"],
        paths: &[],
    },
    Provider {
        name: "Zoom",
        hosts: &["zoom.us", "zoom.com", "zoomgov.com"],
        paths: &["/j/", "/my/", "/w/", "/wc/join/"],
    },
    Provider {
        name: "Microsoft Teams",
        hosts: &["teams.microsoft.com", "teams.live.com"],
        paths: &["/l/meetup-join/", "/meet/", "/l/meet/"],
    },
    Provider {
        name: "Webex",
        hosts: &["webex.com"],
        paths: &["/meet/", "/join/", "/j.php", "/wbxmjs/joinservice/"],
    },
    Provider {
        name: "FaceTime",
        hosts: &["facetime.apple.com"],
        paths: &["/join"],
    },
    Provider {
        name: "GoTo Meeting",
        hosts: &["gotomeeting.com", "meet.goto.com", "gotomeet.me"],
        paths: &[],
    },
    Provider {
        name: "Whereby",
        hosts: &["whereby.com"],
        paths: &[],
    },
    Provider {
        name: "Jitsi Meet",
        hosts: &["meet.jit.si"],
        paths: &[],
    },
    Provider {
        name: "Amazon Chime",
        hosts: &["chime.aws"],
        paths: &[],
    },
    Provider {
        name: "BlueJeans",
        hosts: &["bluejeans.com"],
        paths: &[],
    },
    Provider {
        name: "RingCentral",
        hosts: &["meetings.ringcentral.com", "v.ringcentral.com"],
        paths: &[],
    },
    Provider {
        name: "Skype",
        hosts: &["join.skype.com"],
        paths: &[],
    },
];

/// A web link Pheeme may open in the browser to join a call: `http(s)`, no user name or
/// password in it.
pub fn joinable(url: &str) -> Option<Url> {
    Url::parse(url.trim()).ok().filter(|u| {
        matches!(u.scheme(), "http" | "https")
            && u.username().is_empty()
            && u.password().is_none()
            && u.host_str().is_some()
    })
}

/// The provider whose join link this is, or `None` for any other link.
pub fn provider_of(url: &str) -> Option<&'static str> {
    let url = joinable(url)?;
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path().to_ascii_lowercase();
    PROVIDERS
        .iter()
        .find(|p| {
            p.hosts
                .iter()
                .any(|h| host == *h || host.ends_with(&format!(".{h}")))
                && if p.paths.is_empty() {
                    path.len() > 1
                } else {
                    p.paths.iter().any(|piece| path.contains(piece))
                }
        })
        .map(|p| p.name)
}

/// An explicit conference link (Google's conference data, an invitation's `CONFERENCE`):
/// any web link, named when the provider is known.
pub fn conference(url: &str, name: Option<&str>) -> Option<MeetingLink> {
    let url = joinable(url)?;
    Some(MeetingLink {
        provider: provider_of(url.as_str())
            .or(name)
            .filter(|n| !n.trim().is_empty())
            .map(str::to_owned),
        url: url.to_string(),
    })
}

/// The first join link in free text: a location, or a description (plain or HTML, with
/// Outlook's Safe Links and Google's redirect links unwrapped).
pub fn in_text(text: &str) -> Option<MeetingLink> {
    let mut rest = text;
    while let Some(at) = rest.find("http") {
        let tail = &rest[at..];
        let end = tail
            .find(|c: char| {
                c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | ')' | ']' | '|')
            })
            .unwrap_or(tail.len());
        let found = tail[..end]
            .trim_end_matches(['.', ',', ';', ':', '!', '?'])
            .replace("&amp;", "&");
        let url = unwrap_redirect(&found).unwrap_or(found);
        if let Some(provider) = provider_of(&url) {
            return Some(MeetingLink {
                url: joinable(&url)?.to_string(),
                provider: Some(provider.to_owned()),
            });
        }
        rest = &tail[4..];
    }
    None
}

/// The link a Safe Links (`*.safelinks.protection.outlook.com/?url=`) or Google
/// (`www.google.com/url?q=`) redirect leads to.
fn unwrap_redirect(url: &str) -> Option<String> {
    let parsed = joinable(url)?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let key = if host.ends_with(".safelinks.protection.outlook.com") {
        "url"
    } else if (host == "www.google.com" || host == "google.com") && parsed.path() == "/url" {
        "q"
    } else {
        return None;
    };
    parsed
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

/// An event's call: its conference's video entry point, else its `hangoutLink`, else the
/// first join link in its location, then its description.
pub fn for_event(
    conference_data: Option<&Value>,
    hangout_link: Option<&str>,
    location: Option<&str>,
    description: Option<&str>,
) -> Option<MeetingLink> {
    let from_conference = conference_data.and_then(|c| {
        let name = c
            .get("conferenceSolution")
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str);
        c.get("entryPoints")?
            .as_array()?
            .iter()
            .filter(|p| p.get("entryPointType").and_then(Value::as_str) == Some("video"))
            .filter_map(|p| p.get("uri").and_then(Value::as_str))
            .find_map(|uri| conference(uri, name))
    });
    from_conference
        .or_else(|| hangout_link.and_then(|u| conference(u, Some("Google Meet"))))
        .or_else(|| location.and_then(in_text))
        .or_else(|| description.and_then(in_text))
}

/// A cached event's call (see [`for_event`]).
pub fn of_event(e: &DbEvent) -> Option<MeetingLink> {
    let conference: Option<Value> = e
        .conference
        .as_deref()
        .and_then(|c| serde_json::from_str(c).ok());
    // Google mirrors Meet's `hangoutLink` in the conference data; read the full event only
    // when it has one without the other.
    let hangout: Option<String> = (conference.is_none() && e.raw.contains("\"hangoutLink\""))
        .then(|| serde_json::from_str::<Value>(&e.raw).ok())
        .flatten()
        .and_then(|raw| raw.get("hangoutLink")?.as_str().map(str::to_owned));
    for_event(
        conference.as_ref(),
        hangout.as_deref(),
        e.location.as_deref(),
        e.description.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(text: &str) -> Option<String> {
        in_text(text).and_then(|m| m.provider)
    }

    #[test]
    fn providers_join_links() {
        let cases = [
            ("https://meet.google.com/abc-defg-hij", "Google Meet"),
            ("https://us02web.zoom.us/j/8123456789?pwd=abc", "Zoom"),
            ("https://zoom.us/my/alex", "Zoom"),
            ("https://acme.zoom.com/w/99", "Zoom"),
            ("https://zoomgov.com/j/1610000000", "Zoom"),
            (
                "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x",
                "Microsoft Teams",
            ),
            ("https://teams.microsoft.com/meet/123456789?p=abc", "Microsoft Teams"),
            ("https://teams.live.com/meet/9876543210", "Microsoft Teams"),
            ("https://acme.webex.com/meet/alex", "Webex"),
            ("https://acme.webex.com/acme/j.php?MTID=m123", "Webex"),
            ("https://acme.webex.com/join/alex", "Webex"),
            (
                "https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/download/abc",
                "Webex",
            ),
            ("https://facetime.apple.com/join#v=1&p=AbC", "FaceTime"),
            ("https://meet.goto.com/123456789", "GoTo Meeting"),
            ("https://global.gotomeeting.com/join/123456789", "GoTo Meeting"),
            ("https://whereby.com/acme-standup", "Whereby"),
            ("https://meet.jit.si/AcmeStandup", "Jitsi Meet"),
            ("https://chime.aws/1234567890", "Amazon Chime"),
            ("https://bluejeans.com/123456", "BlueJeans"),
            ("https://v.ringcentral.com/join/123", "RingCentral"),
            ("https://join.skype.com/abcDEF", "Skype"),
        ];
        for (url, name) in cases {
            assert_eq!(provider_of(url), Some(name), "{url}");
        }
    }

    #[test]
    fn other_links_of_a_provider_are_not_join_links() {
        for url in [
            "https://zoom.us/u/abc",
            "https://zoom.us/download",
            "https://zoom.us/",
            "https://teams.microsoft.com/meetingOptions/?organizerId=1",
            "https://help.webex.com/en-us/article/123",
            "https://meet.google.com/",
            "https://meet.google.com.evil.example/abc-defg-hij",
            "https://evilzoom.us/j/123",
            "https://www.microsoft.com/microsoft-teams/join-a-meeting",
            "https://user:pw@zoom.us/j/123",
            "ftp://zoom.us/j/123",
            "https://example.com/agenda",
        ] {
            assert_eq!(provider_of(url), None, "{url}");
        }
    }

    #[test]
    fn finds_the_join_link_in_text() {
        assert_eq!(
            in_text("Join: <https://us02web.zoom.us/j/123?pwd=x>."),
            Some(MeetingLink {
                url: "https://us02web.zoom.us/j/123?pwd=x".into(),
                provider: Some("Zoom".into()),
            })
        );
        assert_eq!(in_text("See https://example.com/agenda"), None);
        // Zoom's text lists the local-numbers page too; the join link counts, wherever it is.
        let zoom = "Find your local number: https://zoom.us/u/abc\n\nJoin Zoom Meeting\nhttps://zoom.us/j/555?pwd=Q";
        assert_eq!(in_text(zoom).unwrap().url, "https://zoom.us/j/555?pwd=Q");
        // HTML descriptions: entities and attributes.
        let html = r#"<a href="https://zoom.us/j/1?pwd=a&amp;uname=b">Join</a>"#;
        assert_eq!(
            in_text(html).unwrap().url,
            "https://zoom.us/j/1?pwd=a&uname=b"
        );
        let teams = "Microsoft Teams meeting<br>Join on your computer<br><a href='https://teams.microsoft.com/l/meetup-join/19%3a1%40thread.v2/0'>Click here</a> | <a href='https://teams.microsoft.com/meetingOptions/'>Meeting options</a>";
        assert_eq!(
            provider(teams).as_deref(),
            Some("Microsoft Teams"),
            "{teams}"
        );
        assert!(in_text(teams).unwrap().url.contains("/l/meetup-join/"));
    }

    #[test]
    fn unwraps_safe_links_and_google_redirects() {
        let safe = "https://nam02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fteams.microsoft.com%2Fl%2Fmeetup-join%2F19%253a1%2540thread.v2%2F0&data=05";
        let m = in_text(safe).unwrap();
        assert_eq!(m.provider.as_deref(), Some("Microsoft Teams"));
        assert_eq!(
            m.url,
            "https://teams.microsoft.com/l/meetup-join/19%3a1%40thread.v2/0"
        );
        let google = "https://www.google.com/url?q=https://acme.webex.com/meet/alex&sa=D";
        assert_eq!(
            in_text(google).unwrap().url,
            "https://acme.webex.com/meet/alex"
        );
        // A redirect to anything else is still not a call.
        assert_eq!(
            in_text("https://www.google.com/url?q=https://example.com/x"),
            None
        );
    }

    #[test]
    fn an_events_conference_comes_first() {
        let zoom_addon = json!({
            "conferenceSolution": {"name": "Zoom Meeting", "key": {"type": "addOn"}},
            "entryPoints": [
                {"entryPointType": "phone", "uri": "tel:+1-555"},
                {"entryPointType": "video", "uri": "https://acme.zoom.us/j/42?pwd=z"},
            ],
        });
        assert_eq!(
            for_event(
                Some(&zoom_addon),
                None,
                Some("https://meet.google.com/aaa-bbbb-ccc"),
                None
            ),
            Some(MeetingLink {
                url: "https://acme.zoom.us/j/42?pwd=z".into(),
                provider: Some("Zoom".into()),
            })
        );
        // A provider not listed keeps its conference's own name.
        let other = json!({
            "conferenceSolution": {"name": "Pexip"},
            "entryPoints": [{"entryPointType": "video", "uri": "https://video.acme.example/room/1"}],
        });
        assert_eq!(
            for_event(Some(&other), None, None, None)
                .unwrap()
                .provider
                .as_deref(),
            Some("Pexip")
        );
        assert_eq!(
            for_event(None, Some("https://meet.google.com/abc"), None, None),
            Some(MeetingLink {
                url: "https://meet.google.com/abc".into(),
                provider: Some("Google Meet".into()),
            })
        );
        // Then the location, then the description.
        assert_eq!(
            for_event(
                None,
                None,
                Some("https://acme.webex.com/meet/alex"),
                Some("https://zoom.us/j/1")
            )
            .unwrap()
            .provider
            .as_deref(),
            Some("Webex")
        );
        assert_eq!(
            for_event(
                None,
                None,
                Some("Room 4"),
                Some("Dial in: https://zoom.us/j/1")
            )
            .unwrap()
            .url,
            "https://zoom.us/j/1"
        );
        assert_eq!(for_event(None, None, Some("Room 4"), Some("Lunch")), None);
    }
}
