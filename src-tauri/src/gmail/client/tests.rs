use super::test_support::*;
use super::*;
use crate::gmail::types::UserProfile;
use crate::gmail::usage::{usage_source, QuotaUsage, SourceUnits};
use std::sync::atomic::Ordering;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn profile_json() -> Value {
    serde_json::from_str(include_str!("../fixtures/profile.json")).unwrap()
}

fn error_json(code: u16, reason: &str, message: &str) -> Value {
    serde_json::json!({"error": {"code": code, "message": message,
        "errors": [{"message": message, "domain": "global", "reason": reason}]}})
}

#[test]
fn backoff_doubles_and_caps() {
    let p = RetryPolicy::default();
    let secs: Vec<_> = (0..7).map(|n| p.backoff(n).as_secs()).collect();
    assert_eq!(secs, [1, 2, 4, 8, 16, 32, 32]);
    assert_eq!(p.backoff(u32::MAX), Duration::from_secs(32));
}

#[test]
fn retry_after_parses_seconds_and_dates() {
    assert_eq!(parse_retry_after("3"), Some(Duration::from_secs(3)));
    assert_eq!(
        parse_retry_after(" 0.25 "),
        Some(Duration::from_millis(250))
    );
    assert_eq!(
        parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT"),
        Some(Duration::ZERO)
    );
    assert_eq!(parse_retry_after("soon"), None);
    assert_eq!(parse_retry_after("-1"), None);
}

#[test]
fn error_body_extracts_reason_and_message() {
    let body = include_bytes!("../fixtures/error_start_history_id.json");
    let (reason, message) = parse_error_body(body, StatusCode::NOT_FOUND);
    assert_eq!(reason.as_deref(), Some("failedPrecondition"));
    assert_eq!(message, "Invalid startHistoryId: 12");

    let (reason, message) = parse_error_body(b"<html>bad gateway</html>", StatusCode::BAD_GATEWAY);
    assert_eq!(reason, None);
    assert_eq!(message, "Bad Gateway");

    let html = b"<!DOCTYPE html><html><title>Error 411 (Length Required)!!1</title></html>";
    let (_, message) = parse_error_body(html, StatusCode::LENGTH_REQUIRED);
    assert_eq!(message, "Length Required");

    let (_, message) = parse_error_body(b"", StatusCode::BAD_GATEWAY);
    assert_eq!(message, "Bad Gateway");
}

#[tokio::test]
async fn injects_bearer_token_and_decodes_json() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/profile"))
        .and(header("authorization", "Bearer token-0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
        .expect(1)
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    let profile: UserProfile = client
        .send_json(ApiRequest::get(&["profile"]))
        .await
        .unwrap();
    assert_eq!(profile.email_address, "alex@example.com");
}

#[tokio::test]
async fn base_url_path_prefix_and_query_are_preserved() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages"))
        .and(query_param("labelIds", "INBOX"))
        .and(query_param("labelIds", "UNREAD"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(&server)
        .await;
    let tokens = Arc::new(CountingTokens::default());
    let client = GmailClient::new(tokens)
        .with_base_url(format!("{}/gmail/v1/users/me/", server.uri()))
        .with_retry_policy(fast_retry());

    let req = ApiRequest::get(&["messages"])
        .query("labelIds", "INBOX")
        .query("labelIds", "UNREAD");
    let _: Value = client.send_json(req).await.unwrap();
}

#[tokio::test]
async fn retries_429_then_succeeds() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(429).set_body_json(error_json(
            429,
            "rateLimitExceeded",
            "slow down",
        )))
        .up_to_n_times(2)
        .expect(2)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
        .expect(1)
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    let profile: UserProfile = client
        .send_json(ApiRequest::get(&["profile"]))
        .await
        .unwrap();
    assert_eq!(profile.history_id, "1204850");
}

#[tokio::test]
async fn bodiless_post_sends_content_length_zero() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/messages/m1/trash"))
        .and(wiremock::matchers::header("content-length", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "m1"})))
        .expect(1)
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    client
        .send_json::<Value>(ApiRequest::post(&["messages", "m1", "trash"]))
        .await
        .unwrap();
}

#[tokio::test]
async fn server_errors_exhaust_retries() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(503).set_body_json(error_json(
            503,
            "backendError",
            "try later",
        )))
        // max_retries = 3 in fast_retry(): the first attempt plus three retries.
        .expect(4)
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    let err = client
        .send_json::<Value>(ApiRequest::get(&["profile"]))
        .await
        .unwrap_err();
    match err {
        GmailError::Api {
            status,
            reason,
            message,
        } => {
            assert_eq!(status, 503);
            assert_eq!(reason.as_deref(), Some("backendError"));
            assert_eq!(message, "try later");
        }
        other => panic!("expected Api error, got {other:?}"),
    }
}

#[tokio::test]
async fn persistent_429_ends_as_rate_limit() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
        .expect(4)
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    let err = client
        .send_json::<Value>(ApiRequest::get(&["profile"]))
        .await
        .unwrap_err();
    assert!(matches!(err, GmailError::RateLimit { .. }), "{err:?}");
    assert_eq!(err.code(), "rate_limit");
}

#[tokio::test]
async fn client_errors_are_not_retried() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(404).set_body_json(error_json(
            404,
            "notFound",
            "Requested entity was not found.",
        )))
        .expect(1)
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    let err = client
        .send_json::<Value>(ApiRequest::get(&["messages", "nope"]))
        .await
        .unwrap_err();
    assert!(err.is_not_found());
}

fn retry_after_client(server: &MockServer) -> GmailClient {
    GmailClient::new(Arc::new(CountingTokens::default()))
        .with_base_url(server.uri())
        .with_retry_policy(RetryPolicy {
            max_retries: 2,
            base_delay: Duration::from_millis(1),
            multiplier: 2,
            max_delay: Duration::from_millis(500),
        })
}

#[tokio::test]
async fn retry_after_header_is_honoured() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0.3"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
        .mount(&server)
        .await;
    // Backoff alone would wait 1 ms; Retry-After asks for 300 ms, within the 500 ms cap.
    let started = Instant::now();
    let _: Value = retry_after_client(&server)
        .send_json(ApiRequest::get(&["profile"]))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(300),
        "waited only {elapsed:?}"
    );
}

#[tokio::test]
async fn retry_after_beyond_cap_returns_rate_limit_without_retrying() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "120"))
        .expect(1)
        .mount(&server)
        .await;
    let err = retry_after_client(&server)
        .send_json::<Value>(ApiRequest::get(&["profile"]))
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        GmailError::RateLimit { retry_after: Some(d) } if d == Duration::from_secs(120)
    ));
}

#[tokio::test]
async fn refreshes_token_on_401_and_retries() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(header("authorization", "Bearer token-0"))
        .respond_with(ResponseTemplate::new(401).set_body_json(error_json(
            401,
            "authError",
            "Invalid Credentials",
        )))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(header("authorization", "Bearer token-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
        .expect(1)
        .mount(&server)
        .await;
    let (client, tokens) = client_for(&server);

    let _: UserProfile = client
        .send_json(ApiRequest::get(&["profile"]))
        .await
        .unwrap();
    assert_eq!(tokens.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn second_401_is_an_auth_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401).set_body_json(error_json(
            401,
            "authError",
            "Invalid Credentials",
        )))
        // One original attempt and exactly one retry after the refresh.
        .expect(2)
        .mount(&server)
        .await;
    let (client, tokens) = client_for(&server);

    let err = client
        .send_json::<Value>(ApiRequest::get(&["profile"]))
        .await
        .unwrap_err();
    assert!(matches!(err, GmailError::Auth(_)), "{err:?}");
    assert_eq!(err.code(), "auth");
    assert_eq!(tokens.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unreachable_server_ends_as_network_error() {
    // Bind then drop a listener to get a port nothing is listening on.
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let tokens = Arc::new(CountingTokens::default());
    let client = GmailClient::new(tokens)
        .with_base_url(format!("http://127.0.0.1:{port}"))
        .with_retry_policy(fast_retry());

    let err = client
        .send_json::<Value>(ApiRequest::get(&["profile"]))
        .await
        .unwrap_err();
    assert!(matches!(err, GmailError::Offline(_)), "{err:?}");
    assert_eq!(err.code(), "network");
}

#[tokio::test]
async fn reqwest_errors_are_logged_without_urls() {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let client = GmailClient::new(Arc::new(CountingTokens::default()))
        .with_base_url(format!("http://127.0.0.1:{port}"))
        .with_retry_policy(fast_retry());

    let err = client
        .send_json::<Value>(ApiRequest::get(&["x"]).query("q", "secret"))
        .await
        .unwrap_err();

    assert!(matches!(err, GmailError::Offline(_)), "{err:?}");
    assert!(!err.to_string().contains("secret"), "{err}");
    assert!(!format!("{err:?}").contains("secret"), "{err:?}");
}

#[tokio::test]
async fn malformed_success_body_is_a_decode_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    let err = client
        .send_json::<UserProfile>(ApiRequest::get(&["profile"]))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "decode");
}

#[test]
fn quota_units_follow_gmail_costs() {
    let units = |req: ApiRequest| req.quota_units();
    assert_eq!(units(ApiRequest::get(&["profile"])), 1);
    assert_eq!(units(ApiRequest::get(&["labels", "INBOX"])), 1);
    assert_eq!(units(ApiRequest::get(&["history"])), 2);
    assert_eq!(units(ApiRequest::get(&["messages", "m1"])), 5);
    assert_eq!(units(ApiRequest::get(&["messages"])), 5);
    assert_eq!(units(ApiRequest::get(&["threads", "t1"])), 10);
    assert_eq!(units(ApiRequest::post(&["threads", "t1", "modify"])), 10);
    assert_eq!(units(ApiRequest::post(&["messages", "batchModify"])), 50);
    assert_eq!(units(ApiRequest::post(&["messages", "send"])), 100);
    assert_eq!(units(ApiRequest::post(&["drafts", "send"])), 100);
}

#[test]
fn jitter_stays_within_half_to_full_delay() {
    for _ in 0..200 {
        let d = jittered(Duration::from_millis(1000));
        assert!(d >= Duration::from_millis(500) && d <= Duration::from_millis(1000));
    }
}

#[test]
fn rate_limits_halve_the_pace_and_time_restores_it() {
    let limiter = QuotaLimiter::fixed(200);
    limiter.rate_limited();
    assert!((limiter.rate() - 100.0).abs() < 1.0);
    limiter.rate_limited(); // same burst of rejections: no second cut
    assert!((limiter.rate() - 100.0).abs() < 1.0);

    // Half a recovery period after a cut to half rate, it's back to full.
    let mut pace = limiter.pace();
    pace.cut = Some((100.0, Instant::now() - QUOTA_RECOVERY / 2));
    drop(pace);
    assert_eq!(limiter.rate(), 200.0);
}

#[tokio::test]
async fn requests_are_paced_under_the_quota() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    // 10 units a second with a 1 s burst: three 5-unit gets go at once, the fourth waits
    // ~0.5 s.
    let client = client_for(&server).0.with_quota(10);
    let started = Instant::now();
    for _ in 0..4 {
        let _: Value = client
            .send_json(ApiRequest::get(&["messages", "m1"]))
            .await
            .unwrap();
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(450),
        "waited only {elapsed:?}"
    );
}

#[tokio::test]
async fn background_requests_get_a_smaller_share_of_the_quota() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    let client = client_for(&server)
        .0
        .with_quota(100_000)
        .with_background_quota(10);

    // Foreground calls aren't held to the background share.
    let started = Instant::now();
    for _ in 0..4 {
        let _: Value = client
            .send_json(ApiRequest::get(&["messages", "m1"]))
            .await
            .unwrap();
    }
    assert!(started.elapsed() < Duration::from_millis(400));

    // Background calls are: three go in the burst, the fourth waits ~0.5 s.
    let started = Instant::now();
    for _ in 0..4 {
        let _: Value = client
            .send_json(ApiRequest::get(&["messages", "m1"]).background())
            .await
            .unwrap();
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(450),
        "waited only {elapsed:?}"
    );
}

#[tokio::test]
async fn background_requests_give_up_on_the_first_rate_limit() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(403).set_body_json(error_json(
            403,
            "rateLimitExceeded",
            "Quota exceeded",
        )))
        .expect(1)
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    let err = client
        .send_json::<Value>(ApiRequest::get(&["messages", "m1"]).background())
        .await
        .unwrap_err();
    assert!(matches!(err, GmailError::RateLimit { .. }), "{err:?}");
}

#[tokio::test]
async fn a_changed_quota_setting_applies_to_running_clients() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    // 750 a minute: the client's 80% is 10 units a second, as in the test above.
    let setting = QuotaSetting::new(750);
    let client = client_for(&server).0.with_quota_setting(&setting);
    let gets = || async {
        let started = Instant::now();
        for _ in 0..4 {
            let _: Value = client
                .send_json(ApiRequest::get(&["messages", "m1"]))
                .await
                .unwrap();
        }
        started.elapsed()
    };
    let slow = gets().await;
    assert!(slow >= Duration::from_millis(450), "waited only {slow:?}");

    setting.set(600_000);
    // Let the slots already booked at the old rate pass.
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let fast = gets().await;
    assert!(fast < Duration::from_millis(400), "still paced: {fast:?}");
}

#[tokio::test]
async fn probe_upgrades_sync_requests_to_interactive() {
    use crate::gmail::probe::{with_probe, RequestProbe};
    use crate::gmail::MessageFormat;
    use tokio::sync::Semaphore;

    let server = MockServer::start().await;
    let started = Arc::new(Semaphore::new(0));
    let arrivals = started.clone();
    Mock::given(method("GET"))
        .and(wiremock::matchers::path_regex(r"^/messages/slow[0-9]+$"))
        .respond_with(move |_: &wiremock::Request| {
            arrivals.add_permits(1);
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"id": "slow", "threadId": "t0"}))
                .set_delay(Duration::from_secs(10))
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/messages/m1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"id": "m1", "threadId": "t1"})),
        )
        .mount(&server)
        .await;
    let client = client_for(&server).0.with_quota(100_000);
    let sync = client.clone();
    let task = tokio::spawn(async move {
        let ids: Vec<_> = (0..MAX_BACKGROUND_REQUESTS)
            .map(|i| format!("slow{i}"))
            .collect();
        sync.batch_get_messages(&ids, MessageFormat::Full).await
    });
    tokio::time::timeout(
        Duration::from_secs(3),
        started.acquire_many(MAX_BACKGROUND_REQUESTS as u32),
    )
    .await
    .expect("sync requests reached Gmail")
    .unwrap()
    .forget();

    let probe = RequestProbe::new(|_| {});
    let ids = ["m1".to_owned()];
    let opened = with_probe(
        probe.clone(),
        client.batch_get_messages(&ids, MessageFormat::Full),
    );
    let result = tokio::time::timeout(Duration::from_secs(1), opened).await;
    task.abort();
    let result = result.expect("the opened thread waited behind sync");
    assert!(result[0].1.is_ok(), "{result:?}");
    assert_eq!(probe.snapshot().requests, 1);
}

#[tokio::test]
async fn probe_reports_retry_stage_and_stats() {
    use crate::gmail::probe::{with_probe, ProbeStage, RequestProbe, RetryReason};

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("Retry-After", "1")
                .set_body_json(error_json(429, "rateLimitExceeded", "slow down")),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
        .mount(&server)
        .await;
    let client = retry_after_client(&server).with_retry_policy(RetryPolicy {
        max_retries: 2,
        base_delay: Duration::from_millis(1),
        multiplier: 2,
        max_delay: Duration::from_secs(2),
    });
    let stages = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = stages.clone();
    let probe = RequestProbe::new(move |s| seen.lock().unwrap().push(s));

    let _: Value = with_probe(
        probe.clone(),
        client.send_json(ApiRequest::get(&["profile"])),
    )
    .await
    .unwrap();

    assert_eq!(
        *stages.lock().unwrap(),
        [
            ProbeStage::Queued,
            ProbeStage::Fetching,
            ProbeStage::Retrying {
                attempt: 0,
                retry_in: Duration::from_secs(1),
                reason: RetryReason::RateLimited,
            },
            ProbeStage::Fetching,
        ]
    );
    let stats = probe.snapshot();
    assert_eq!(stats.retries, 1);
    assert_eq!(stats.requests, 2);
    assert_eq!(stats.last_status, Some(429));
    assert_eq!(stats.last_reason.as_deref(), Some("rateLimitExceeded"));
}

#[test]
fn quota_setting_stays_in_range() {
    let setting = QuotaSetting::new(10);
    assert_eq!(setting.get(), 600);
    assert_eq!(setting.set(u32::MAX), 1_200_000);
    assert_eq!(QuotaSetting::default().get(), 6_000);
}

#[tokio::test(start_paused = true)]
async fn user_requests_skip_the_queue_and_are_paced_among_themselves() {
    let limiter = QuotaLimiter::fixed(10);
    // Sync and the backfill have booked 10 s ahead.
    limiter.pace().next = Instant::now() + Duration::from_secs(10);
    let start = Instant::now();
    // 10 units a second with a 5 s burst: 60 units go at once, the next 10 a second later.
    for _ in 0..6 {
        limiter.take_first(10).await;
    }
    assert_eq!(start.elapsed(), Duration::ZERO);
    limiter.take_first(10).await;
    assert_eq!(start.elapsed(), Duration::from_secs(1));
    // Their 70 units fall on the requests behind: 10 s booked + 7 s, less the 1 s burst.
    limiter.take(5).await;
    assert_eq!(start.elapsed(), Duration::from_secs(16));
}

/// Hands out tokens, but the first request for one hangs until released (a keychain prompt).
struct StuckFirstToken {
    calls: std::sync::atomic::AtomicUsize,
    release: Semaphore,
}

#[async_trait::async_trait]
impl TokenProvider for StuckFirstToken {
    async fn access_token(&self) -> Result<String, GmailError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            let _ = self.release.acquire().await;
        }
        Ok("token-0".into())
    }

    async fn refresh_access_token(&self) -> Result<String, GmailError> {
        self.access_token().await
    }
}

#[tokio::test]
async fn sync_waits_for_a_user_request_but_not_for_its_token() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/messages/mine"))
        .respond_with(ResponseTemplate::new(503).insert_header("Retry-After", "0.3"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    let tokens = Arc::new(StuckFirstToken {
        calls: Default::default(),
        release: Semaphore::new(0),
    });
    let client = GmailClient::new(tokens.clone()).with_base_url(server.uri());
    let c = client.clone();
    let mine = tokio::spawn(user_action(async move {
        c.send_json::<Value>(ApiRequest::get(&["messages", "mine"]))
            .await
    }));
    while tokens.calls.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let sync = client.send_json::<Value>(ApiRequest::get(&["history"]));
    tokio::time::timeout(Duration::from_secs(1), sync)
        .await
        .expect("sync waited for the user's token")
        .unwrap();

    // Issued while the user's request sleeps before its retry: it goes after, not between.
    tokens.release.add_permits(1);
    while server.received_requests().await.unwrap().len() < 2 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _: Value = client
        .send_json(ApiRequest::get(&["messages", "sync"]))
        .await
        .unwrap();
    mine.await.unwrap().unwrap();
    assert_eq!(
        sent_paths(&server).await,
        [
            "/history",
            "/messages/mine",
            "/messages/mine",
            "/messages/sync"
        ]
    );
}

#[tokio::test]
async fn a_rate_limit_cools_background_down_but_not_the_user() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/history"))
        .respond_with(ResponseTemplate::new(403).set_body_json(error_json(
            403,
            "rateLimitExceeded",
            "Rate Limit Exceeded",
        )))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    let (client, _) = client_for(&server);

    // Sync is rate-limited, and its retry waits out the pause.
    let started = Instant::now();
    let _: Value = client
        .send_json(ApiRequest::get(&["history"]))
        .await
        .unwrap();
    assert!(started.elapsed() >= QUOTA_BURST, "{:?}", started.elapsed());

    // The backfill, its mailbox-size read included, is turned away unsent with the time left.
    for err in [
        client
            .send_json::<Value>(ApiRequest::get(&["messages", "m1"]).background())
            .await
            .unwrap_err(),
        client.backfill_profile().await.unwrap_err(),
    ] {
        assert!(
            matches!(err, GmailError::RateLimit { retry_after: Some(left) }
                if left > RATE_LIMIT_COOLDOWN - Duration::from_secs(10)),
            "{err:?}"
        );
    }
    // Then it restarts at a quarter of its pace, and is back to full 45 s later.
    {
        let bulk = &client.bulk_quota;
        let pace = bulk.pace();
        let (_, until) = pace.cut.unwrap();
        assert!(pace.next >= until);
        assert_eq!(bulk.rate_at(&pace, until), bulk.max_rate() / 4.0);
        let later = until + Duration::from_secs(45);
        assert_eq!(bulk.rate_at(&pace, later), bulk.max_rate());
    }

    // The user's request goes ahead of everything booked, cooldown or not.
    client.quota.pace().next = Instant::now() + Duration::from_secs(10);
    let mine = user_action(client.send_json::<Value>(ApiRequest::get(&["labels", "L1"])));
    tokio::time::timeout(Duration::from_millis(500), mine)
        .await
        .expect("the user's request waited")
        .unwrap();
    assert_eq!(
        sent_paths(&server).await,
        ["/history", "/history", "/labels/L1"]
    );
}

fn metered(server: &MockServer) -> (GmailClient, QuotaUsage) {
    let usage = QuotaUsage::default();
    let client = client_for(server).0.with_usage(usage.account("a1"));
    (client, usage)
}

/// The units and refusals of the last hour, summed.
fn hour(usage: &QuotaUsage) -> (SourceUnits, u32) {
    let mut total = SourceUnits::default();
    let mut refused = 0;
    for m in usage.report("a1", 6_000).minutes {
        total.new_mail += m.units.new_mail;
        total.older_mail += m.units.older_mail;
        total.your_changes += m.units.your_changes;
        total.you_asked += m.units.you_asked;
        total.assistants += m.units.assistants;
        refused += m.refused;
    }
    (total, refused)
}

#[tokio::test]
async fn usage_is_counted_by_source() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    let (client, usage) = metered(&server);
    let get = |segments: &[&str]| client.send_json::<Value>(ApiRequest::get(segments));

    // Sync: `history` is 2 units.
    get(&["history"]).await.unwrap();
    // The backfill: a message is 5.
    client
        .send_json::<Value>(ApiRequest::get(&["messages", "m1"]).background())
        .await
        .unwrap();
    // The user opened a thread: 10.
    user_action(get(&["threads", "t1"])).await.unwrap();
    // The outbox, inside `user_action`: a label read is 1.
    user_action(usage_source(
        UsageSource::YourChanges,
        get(&["labels", "L1"]),
    ))
    .await
    .unwrap();
    // An assistant's call: its scope wins over `user_action` and an outer scope.
    user_action(usage_source(
        UsageSource::YourChanges,
        usage_source(UsageSource::Assistants, get(&["threads", "t2"])),
    ))
    .await
    .unwrap();
    // A scope wins over the backfill's priority too.
    usage_source(
        UsageSource::Assistants,
        client.send_json::<Value>(ApiRequest::get(&["messages", "m2"]).background()),
    )
    .await
    .unwrap();

    assert_eq!(
        hour(&usage),
        (
            SourceUnits {
                new_mail: 2,
                older_mail: 5,
                your_changes: 1,
                you_asked: 10,
                assistants: 15,
            },
            0
        )
    );
}

#[tokio::test]
async fn every_attempt_and_every_refusal_is_counted() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(429).set_body_json(error_json(
            429,
            "rateLimitExceeded",
            "slow down",
        )))
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/profile"))
        .respond_with(ResponseTemplate::new(200).set_body_json(profile_json()))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/labels"))
        .respond_with(ResponseTemplate::new(403).set_body_json(error_json(
            403,
            "insufficientPermissions",
            "no",
        )))
        .mount(&server)
        .await;
    let (client, usage) = metered(&server);

    // Refused twice, then answered: three attempts of 1 unit, two refusals.
    let _: UserProfile = client
        .send_json(ApiRequest::get(&["profile"]))
        .await
        .unwrap();
    // A 403 that isn't the rate limit is charged but isn't a refusal.
    client
        .send_json::<Value>(ApiRequest::get(&["labels"]))
        .await
        .unwrap_err();
    let (units, refused) = hour(&usage);
    assert_eq!(units.new_mail, 4);
    assert_eq!(refused, 2);
}

#[tokio::test]
async fn a_refused_background_request_is_counted_once() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(403).set_body_json(error_json(
            403,
            "rateLimitExceeded",
            "User-rate limit exceeded",
        )))
        .mount(&server)
        .await;
    let (client, usage) = metered(&server);
    client
        .send_json::<Value>(ApiRequest::get(&["messages", "m1"]).background())
        .await
        .unwrap_err();
    let (units, refused) = hour(&usage);
    assert_eq!(units.older_mail, 5);
    assert_eq!(refused, 1);
}

#[tokio::test]
async fn requests_that_never_reach_gmail_cost_nothing() {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let usage = QuotaUsage::default();
    let client = GmailClient::new(Arc::new(CountingTokens::default()))
        .with_base_url(format!("http://127.0.0.1:{port}"))
        .with_retry_policy(fast_retry())
        .with_usage(usage.account("a1"));
    client
        .send_json::<Value>(ApiRequest::get(&["profile"]))
        .await
        .unwrap_err();
    assert_eq!(hour(&usage), (SourceUnits::default(), 0));
}

async fn sent_paths(server: &MockServer) -> Vec<String> {
    let sent = server.received_requests().await.unwrap();
    sent.iter().map(|r| r.url.path().to_owned()).collect()
}
