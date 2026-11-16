//! The pure parts of [`GmailClient::execute`]: building each attempt and classifying errors.

use super::*;

const MAX_DELAY: Duration = Duration::from_secs(32);

fn verdict(status: u16, reason: Option<&str>) -> Verdict {
    let status = StatusCode::from_u16(status).unwrap();
    classify(status, reason, None, false, true, MAX_DELAY)
}

#[test]
fn unauthorized_refreshes_the_token() {
    assert_eq!(verdict(401, None), Verdict::RefreshToken);
    assert!(!Verdict::RefreshToken.rate_limited());
}

#[test]
fn rate_limits_are_429_or_a_403_that_says_so() {
    let limited = Verdict::Retry { rate_limited: true };
    assert_eq!(verdict(429, None), limited);
    assert_eq!(verdict(403, Some("rateLimitExceeded")), limited);
    assert_eq!(verdict(403, Some("userRateLimitExceeded")), limited);
    assert_eq!(
        verdict(403, Some("insufficientPermissions")),
        Verdict::Fail {
            rate_limited: false
        }
    );
    assert!(limited.rate_limited());
}

#[test]
fn server_errors_retry_only_when_resending_is_safe() {
    let status = StatusCode::SERVICE_UNAVAILABLE;
    assert_eq!(
        classify(status, None, None, false, true, MAX_DELAY),
        Verdict::Retry {
            rate_limited: false
        }
    );
    assert_eq!(
        classify(status, None, None, false, false, MAX_DELAY),
        Verdict::Fail {
            rate_limited: false
        }
    );
}

#[test]
fn other_errors_fail_at_once() {
    for status in [400, 404, 409, 412] {
        assert_eq!(
            verdict(status, None),
            Verdict::Fail {
                rate_limited: false
            },
            "{status}"
        );
    }
}

#[test]
fn background_work_gives_up_on_a_rate_limit_but_retries_a_server_error() {
    let classify_bg = |status| classify(status, None, None, true, true, MAX_DELAY);
    assert_eq!(
        classify_bg(StatusCode::TOO_MANY_REQUESTS),
        Verdict::Fail { rate_limited: true }
    );
    assert_eq!(
        classify_bg(StatusCode::BAD_GATEWAY),
        Verdict::Retry {
            rate_limited: false
        }
    );
}

#[test]
fn a_retry_after_past_the_cap_goes_back_to_the_caller() {
    let status = StatusCode::TOO_MANY_REQUESTS;
    let at = |secs| classify(status, None, Some(secs), false, true, MAX_DELAY);
    assert_eq!(at(MAX_DELAY), Verdict::Retry { rate_limited: true });
    assert_eq!(
        at(MAX_DELAY + Duration::from_secs(1)),
        Verdict::Fail { rate_limited: true }
    );
}

fn build(req: &ApiRequest) -> reqwest::Request {
    let url = reqwest::Url::parse("https://gmail.test/users/me/x").unwrap();
    build_request(&crate::http::client(), req, url, "tok")
        .build()
        .unwrap()
}

#[test]
fn a_request_carries_the_bearer_headers_and_query() {
    let built = build(
        &ApiRequest::get(&["messages"])
            .query("labelIds", "INBOX")
            .query("labelIds", "UNREAD")
            .header("If-Match", "etag"),
    );
    assert_eq!(built.method(), Method::GET);
    assert_eq!(built.url().query(), Some("labelIds=INBOX&labelIds=UNREAD"));
    assert_eq!(built.headers()["authorization"], "Bearer tok");
    assert_eq!(built.headers()["if-match"], "etag");
    assert!(built.body().is_none());
    assert_eq!(built.timeout(), None);
}

#[test]
fn a_bodiless_post_says_its_length_is_zero() {
    let built = build(&ApiRequest::post(&["messages", "m1", "trash"]));
    assert_eq!(built.headers()["content-length"], "0");
    assert_eq!(built.body().and_then(|b| b.as_bytes()), Some(&b""[..]));
    // A GET doesn't.
    assert!(!build(&ApiRequest::get(&["profile"]))
        .headers()
        .contains_key("content-length"));
}

#[test]
fn a_json_body_is_sent_as_json() {
    let built = build(&ApiRequest::post(&["labels"]).json(serde_json::json!({"name": "A"})));
    assert_eq!(built.headers()["content-type"], "application/json");
    assert_eq!(
        built.body().and_then(|b| b.as_bytes()),
        Some(&br#"{"name":"A"}"#[..])
    );
}

#[test]
fn an_upload_is_multipart_with_the_longer_timeout() {
    let built = build(
        &ApiRequest::post(&["messages", "send"]).upload_message(serde_json::json!({}), b"raw"),
    );
    let content_type = built.headers()["content-type"].to_str().unwrap();
    assert!(content_type.starts_with("multipart/related; boundary=pheeme-"));
    assert_eq!(built.timeout(), Some(&UPLOAD_TIMEOUT));
    assert_eq!(built.url().query(), Some("uploadType=multipart"));
}
