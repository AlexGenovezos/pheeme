//! Anonymous usage ping: once a day, a random install ID plus the Pheeme version, OS and
//! chip type go to the diagnostics Worker, so the developer can count active installs and
//! see what they run on. Nothing about the user, their accounts or their mail is sent.
//!
//! Alongside it, the usage report: the app counts per local day which screens were open
//! (how often, how long) and which commands ran by shortcut, palette or button
//! ([`record`], `usage_counts`), and [`send_usage`] sends each finished day to `/v1/usage`
//! with the user's rebound shortcuts and the number of connected accounts. Names are fixed
//! strings the app defines, never user content, and nothing says in what order things
//! happened.
//!
//! On by default; Settings › About and the welcome screen turn it off, which also
//! forgets the install ID and the counts not yet sent. Nothing is sent until an account is connected, so someone who
//! turns it off on the welcome screen is never counted. Debug builds never ping unless
//! `PHEEME_TELEMETRY_URL` is set.

use crate::db;
use crate::db::usage::UsageRow;
use crate::sync::engine::now_ms;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::Duration;

/// Where pings go; `PHEEME_TELEMETRY_URL` overrides it (for testing).
pub const TELEMETRY_URL: &str = "https://diagnostics.pheeme.email/v1/ping";

/// Least time between pings. A little under a day, so someone who opens Pheeme each
/// morning is counted each day even if they open it a bit earlier than the day before.
const MIN_GAP_MS: i64 = 20 * 60 * 60 * 1000;
/// How long after launch the first check runs, out of the way of startup work.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(60);
/// How often a running app checks whether a ping is due.
const CHECK_EVERY: Duration = Duration::from_secs(60 * 60);
const TIMEOUT: Duration = Duration::from_secs(15);
/// The Worker refuses longer fields.
const MAX_FIELD_CHARS: usize = 100;
/// Days not sent by then (the Worker unreachable or refusing) are dropped.
const KEEP_UNSENT_DAYS: i64 = 14;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The most names one report (or one batch from the app) carries; the app has far fewer.
const MAX_NAMES: usize = 500;
/// The most rebound shortcuts kept.
const MAX_REBOUND: usize = 300;
/// Longest screen or command name; the Worker checks the same.
const MAX_NAME_CHARS: usize = 80;
/// Kinds of count: a screen, or how a command ran.
const KINDS: [&str; 4] = ["screen", "key", "palette", "button"];

/// Everything a ping carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ping {
    pub install_id: String,
    pub version: String,
    /// `macos`, `windows` or `linux`.
    pub os: String,
    /// For example `macOS 15.1`, `Windows 11 (10.0.26100)` or `Ubuntu 24.04.1 LTS`.
    pub os_version: String,
    /// `aarch64` (Apple Silicon, ARM) or `x86_64` (Intel, AMD).
    pub arch: String,
}

pub fn telemetry_url() -> String {
    std::env::var("PHEEME_TELEMETRY_URL").unwrap_or_else(|_| TELEMETRY_URL.to_owned())
}

/// Release builds ping; debug builds only when pointed at a test URL.
pub fn active_in_this_build() -> bool {
    !cfg!(debug_assertions) || std::env::var_os("PHEEME_TELEMETRY_URL").is_some()
}

/// Check after launch, then every [`CHECK_EVERY`] while the app runs. The ping goes first:
/// the Worker takes usage reports only from installs it already knows.
pub async fn run(db: SqlitePool) {
    let url = telemetry_url();
    let usage = usage_url(&url);
    tokio::time::sleep(FIRST_CHECK_AFTER).await;
    loop {
        match tick(&db, &url, now_ms()).await {
            Ok(true) => tracing::info!("sent the daily anonymous usage ping"),
            Ok(false) => {}
            Err(error) => tracing::debug!(%error, "anonymous usage ping failed"),
        }
        match send_usage(&db, &usage, now_ms()).await {
            Ok(0) => {}
            Ok(days) => tracing::info!(days, "sent the anonymous usage report"),
            Err(error) => tracing::debug!(%error, "anonymous usage report failed"),
        }
        tokio::time::sleep(CHECK_EVERY).await;
    }
}

/// Send a ping if one is due at `now` (ms). Returns whether one was sent.
pub async fn tick(db: &SqlitePool, url: &str, now: i64) -> anyhow::Result<bool> {
    if !db::settings::telemetry(db).await? || db::accounts::list_accounts(db).await?.is_empty() {
        return Ok(false);
    }
    if let Some(last) = db::settings::telemetry_last_ping(db).await? {
        if now - last < MIN_GAP_MS && now >= last {
            return Ok(false);
        }
    }
    let ping = Ping {
        install_id: db::settings::telemetry_install_id(db).await?,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        os: std::env::consts::OS.to_owned(),
        os_version: field(&os_version()),
        arch: std::env::consts::ARCH.to_owned(),
    };
    send(url, &ping).await?;
    // Turned off while the ping was in flight: don't record it.
    if db::settings::telemetry(db).await? {
        db::settings::set_telemetry_last_ping(db, now).await?;
    }
    Ok(true)
}

/// POST the ping as JSON. Any 2xx counts as delivered.
pub async fn send(url: &str, ping: &Ping) -> anyhow::Result<()> {
    post_json(url, ping).await
}

async fn post_json(url: &str, body: &impl Serialize) -> anyhow::Result<()> {
    let http = crate::http::client_builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("pheeme/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let response = http
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|e| e.without_url())?;
    let status = response.status();
    anyhow::ensure!(status.is_success(), "refused ({status})");
    Ok(())
}

/// The usage report endpoint beside the ping's: `…/v1/ping` → `…/v1/usage`.
pub fn usage_url(ping_url: &str) -> String {
    format!(
        "{}/usage",
        ping_url.strip_suffix("/ping").unwrap_or(ping_url)
    )
}

/// One finished day of usage (`POST /v1/usage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub install_id: String,
    /// Local day, `YYYY-MM-DD`.
    pub day: String,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub accounts: usize,
    pub screens: Vec<ScreenUsage>,
    pub commands: Vec<CommandUsage>,
    pub rebound: Vec<Rebound>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenUsage {
    pub name: String,
    pub opens: i64,
    pub ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CommandUsage {
    pub id: String,
    pub key: i64,
    pub palette: i64,
    pub button: i64,
}

/// A shortcut the user changed: the new key, or `None` if they removed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rebound {
    pub id: String,
    pub key: Option<String>,
}

/// What the app reports in one batch (`record_usage`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBatch {
    #[serde(default)]
    pub screens: Vec<ScreenUsage>,
    #[serde(default)]
    pub commands: Vec<CommandUse>,
    /// The user's rebound shortcuts now, replacing the last list; absent leaves it.
    #[serde(default)]
    pub rebound: Option<Vec<Rebound>>,
}

/// One command run `count` times by `source` (`key`, `palette` or `button`).
#[derive(Debug, Clone, Deserialize)]
pub struct CommandUse {
    pub id: String,
    pub source: String,
    pub count: i64,
}

/// A name the report may carry: letters, digits, `.`, `_` and `-`, starting with a letter or
/// digit. App-defined screen and command ids fit; anything else is dropped.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_CHARS
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The rows a batch adds, without anything malformed.
fn batch_rows(batch: &UsageBatch) -> Vec<UsageRow> {
    let screens = batch.screens.iter().map(|s| UsageRow {
        kind: "screen".into(),
        name: s.name.clone(),
        count: s.opens,
        ms: s.ms,
    });
    let commands = batch.commands.iter().map(|c| UsageRow {
        kind: c.source.clone(),
        name: c.id.clone(),
        count: c.count,
        ms: 0,
    });
    screens
        .chain(commands)
        .filter(|r| {
            KINDS.contains(&r.kind.as_str())
                && valid_name(&r.name)
                && (0..=100_000).contains(&r.count)
                && (0..=DAY_MS).contains(&r.ms)
                && (r.count > 0 || r.ms > 0)
        })
        .take(MAX_NAMES)
        .collect()
}

/// Add a batch from the app to today's counts, if usage stats are on. (The command skips this
/// in builds that don't report, [`active_in_this_build`].)
pub async fn record(db: &SqlitePool, batch: &UsageBatch, now: i64) -> anyhow::Result<()> {
    if !db::settings::telemetry(db).await? {
        return Ok(());
    }
    db::usage::add(db, &local_day(now), &batch_rows(batch)).await?;
    if let Some(rebound) = &batch.rebound {
        let kept: Vec<&Rebound> = rebound
            .iter()
            .filter(|r| valid_name(&r.id))
            .filter(|r| r.key.as_deref().is_none_or(|k| k.len() <= MAX_NAME_CHARS))
            .take(MAX_REBOUND)
            .collect();
        db::settings::set_usage_rebound(db, &serde_json::to_string(&kept)?).await?;
    }
    Ok(())
}

/// The local calendar day of `ms`, `YYYY-MM-DD`.
pub fn local_day(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "1970-01-01".to_owned())
}

/// Send each finished day's usage, oldest first, deleting each once it's accepted. Days older
/// than [`KEEP_UNSENT_DAYS`] are dropped unsent. Stops at the first failure, to try again at
/// the next check. Returns how many days went out.
pub async fn send_usage(db: &SqlitePool, url: &str, now: i64) -> anyhow::Result<usize> {
    if !db::settings::telemetry(db).await? {
        return Ok(0);
    }
    let accounts = db::accounts::list_accounts(db).await?.len();
    if accounts == 0 {
        return Ok(0);
    }
    let oldest = local_day(now - KEEP_UNSENT_DAYS * DAY_MS);
    let rebound: Vec<Rebound> = db::settings::usage_rebound(db)
        .await?
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let mut sent = 0;
    for day in db::usage::days_before(db, &local_day(now)).await? {
        if day < oldest {
            db::usage::delete_day(db, &day).await?;
            continue;
        }
        let rows = db::usage::rows_of(db, &day).await?;
        let report = usage_report(
            db::settings::telemetry_install_id(db).await?,
            &day,
            accounts,
            &rows,
            rebound.clone(),
        );
        post_json(url, &report).await?;
        db::usage::delete_day(db, &day).await?;
        sent += 1;
    }
    Ok(sent)
}

/// A day's report from its stored counts.
fn usage_report(
    install_id: String,
    day: &str,
    accounts: usize,
    rows: &[UsageRow],
    rebound: Vec<Rebound>,
) -> UsageReport {
    let screens = rows
        .iter()
        .filter(|r| r.kind == "screen")
        .map(|r| ScreenUsage {
            name: r.name.clone(),
            opens: r.count,
            ms: r.ms,
        })
        .take(MAX_NAMES)
        .collect();
    let mut commands: std::collections::BTreeMap<&str, CommandUsage> = Default::default();
    for r in rows.iter().filter(|r| r.kind != "screen") {
        let entry = commands.entry(&r.name).or_insert_with(|| CommandUsage {
            id: r.name.clone(),
            ..Default::default()
        });
        match r.kind.as_str() {
            "key" => entry.key += r.count,
            "palette" => entry.palette += r.count,
            "button" => entry.button += r.count,
            _ => {}
        }
    }
    UsageReport {
        install_id,
        day: day.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        accounts,
        screens,
        commands: commands.into_values().take(MAX_NAMES).collect(),
        rebound,
    }
}

/// The OS name and version, for example `macOS 15.1`; `unknown` if it can't be read.
pub fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|v| format!("macOS {}", v.trim()))
            .unwrap_or_else(|| "macOS".to_owned())
    }
    #[cfg(target_os = "windows")]
    {
        let v = windows_version::OsVersion::current();
        windows_name(v.major, v.minor, v.build)
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|text| linux_name(&text))
            .unwrap_or_else(|| "Linux".to_owned())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "unknown".to_owned()
    }
}

/// Windows 11 still reports itself as 10.0; build 22000 and later is 11.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn windows_name(major: u32, minor: u32, build: u32) -> String {
    let name = match (major, build) {
        (10, b) if b >= 22000 => "Windows 11",
        (10, _) => "Windows 10",
        _ => "Windows",
    };
    format!("{name} ({major}.{minor}.{build})")
}

/// `PRETTY_NAME` from `/etc/os-release`, else `NAME VERSION_ID`.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn linux_name(os_release: &str) -> Option<String> {
    let value = |key: &str| {
        os_release.lines().find_map(|line| {
            let rest = line.strip_prefix(key)?.strip_prefix('=')?;
            let v = rest.trim().trim_matches('"').trim_matches('\'').trim();
            (!v.is_empty()).then(|| v.to_owned())
        })
    };
    value("PRETTY_NAME").or_else(|| {
        let name = value("NAME")?;
        Some(match value("VERSION_ID") {
            Some(version) => format!("{name} {version}"),
            None => name,
        })
    })
}

/// What the Worker accepts: no control characters, at most [`MAX_FIELD_CHARS`].
fn field(value: &str) -> String {
    let clean: String = value
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_FIELD_CHARS)
        .collect();
    if clean.is_empty() {
        "unknown".to_owned()
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn server(status: u16) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/ping"))
            .respond_with(ResponseTemplate::new(status))
            .mount(&server)
            .await;
        server
    }

    fn url(server: &MockServer) -> String {
        format!("{}/v1/ping", server.uri())
    }

    #[tokio::test]
    async fn pings_once_a_day_with_the_same_install_id() {
        let db = TestDb::with_account("a").await;
        let server = server(204).await;
        let now = 1_800_000_000_000;

        assert!(tick(&db.pool, &url(&server), now).await.unwrap());
        assert!(!tick(&db.pool, &url(&server), now + 60_000).await.unwrap());
        assert!(tick(&db.pool, &url(&server), now + DAY_MS).await.unwrap());

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2);
        let bodies: Vec<serde_json::Value> = requests
            .iter()
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .collect();
        assert_eq!(bodies[0]["installId"], bodies[1]["installId"]);
        let keys: Vec<&String> = bodies[0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["arch", "installId", "os", "osVersion", "version"]);
        assert_eq!(bodies[0]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(bodies[0]["os"], std::env::consts::OS);
    }

    #[tokio::test]
    async fn sends_nothing_when_turned_off() {
        let db = TestDb::with_account("a").await;
        let server = server(204).await;
        db::settings::set_telemetry(&db.pool, false).await.unwrap();
        assert!(!tick(&db.pool, &url(&server), 1_800_000_000_000)
            .await
            .unwrap());
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sends_nothing_before_an_account_is_connected() {
        let db = TestDb::new().await;
        let server = server(204).await;
        assert!(!tick(&db.pool, &url(&server), 1_800_000_000_000)
            .await
            .unwrap());
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_refused_ping_is_retried_at_the_next_check() {
        let db = TestDb::with_account("a").await;
        let refused = server(500).await;
        let now = 1_800_000_000_000;
        assert!(tick(&db.pool, &url(&refused), now).await.is_err());
        assert_eq!(
            db::settings::telemetry_last_ping(&db.pool).await.unwrap(),
            None
        );

        let ok = server(204).await;
        assert!(tick(&db.pool, &url(&ok), now + 60_000).await.unwrap());
    }

    fn batch(json: serde_json::Value) -> UsageBatch {
        serde_json::from_value(json).unwrap()
    }

    async fn usage_server(status: u16) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/usage"))
            .respond_with(ResponseTemplate::new(status))
            .mount(&server)
            .await;
        server
    }

    #[test]
    fn the_usage_report_goes_beside_the_ping() {
        assert_eq!(
            usage_url("https://diagnostics.pheeme.email/v1/ping"),
            "https://diagnostics.pheeme.email/v1/usage"
        );
    }

    #[test]
    fn a_batch_keeps_only_well_formed_counts() {
        let rows = batch_rows(&batch(serde_json::json!({
            "screens": [
                { "name": "mail.inbox", "opens": 2, "ms": 5000 },
                { "name": "mod:secret", "opens": 1, "ms": 1 },
                { "name": "calendar.week", "opens": 0, "ms": 0 },
            ],
            "commands": [
                { "id": "view.toggleSidebar", "source": "key", "count": 3 },
                { "id": "go.inbox", "source": "voice", "count": 1 },
                { "id": "Label 5", "source": "button", "count": 1 },
                { "id": "go.inbox", "source": "palette", "count": -4 },
            ],
        })));
        assert_eq!(
            rows,
            [
                UsageRow {
                    kind: "screen".into(),
                    name: "mail.inbox".into(),
                    count: 2,
                    ms: 5000
                },
                UsageRow {
                    kind: "key".into(),
                    name: "view.toggleSidebar".into(),
                    count: 3,
                    ms: 0
                },
            ]
        );
    }

    #[tokio::test]
    async fn sends_each_finished_day_once_then_forgets_it() {
        let db = TestDb::with_account("a").await;
        let now = 1_800_000_000_000;
        let yesterday = local_day(now - DAY_MS);
        db::usage::add(
            &db.pool,
            &yesterday,
            &batch_rows(&batch(serde_json::json!({
                "screens": [{ "name": "calendar.week", "opens": 1, "ms": 60000 }],
                "commands": [
                    { "id": "go.inbox", "source": "key", "count": 2 },
                    { "id": "go.inbox", "source": "palette", "count": 1 },
                ],
            }))),
        )
        .await
        .unwrap();
        record(
            &db.pool,
            &batch(serde_json::json!({
                "commands": [{ "id": "compose.new", "source": "button", "count": 1 }],
                "rebound": [{ "id": "go.inbox", "key": "g h" }, { "id": "calendar.today", "key": null }],
            })),
            now,
        )
        .await
        .unwrap();
        let server = usage_server(204).await;
        let url = format!("{}/v1/usage", server.uri());

        assert_eq!(send_usage(&db.pool, &url, now).await.unwrap(), 1);
        assert_eq!(send_usage(&db.pool, &url, now).await.unwrap(), 0);

        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body["day"], yesterday.as_str());
        assert_eq!(body["accounts"], 1);
        assert_eq!(
            body["installId"],
            db::settings::telemetry_install_id(&db.pool).await.unwrap()
        );
        assert_eq!(
            body["screens"],
            serde_json::json!([{ "name": "calendar.week", "opens": 1, "ms": 60000 }])
        );
        assert_eq!(
            body["commands"],
            serde_json::json!([{ "id": "go.inbox", "key": 2, "palette": 1, "button": 0 }])
        );
        assert_eq!(
            body["rebound"],
            serde_json::json!([{ "id": "go.inbox", "key": "g h" }, { "id": "calendar.today", "key": null }])
        );
        // Today's counts wait for tomorrow.
        assert_eq!(
            db::usage::days_before(&db.pool, "9999-12-31")
                .await
                .unwrap(),
            [local_day(now)]
        );
    }

    #[tokio::test]
    async fn a_refused_report_is_kept_until_it_is_too_old() {
        let db = TestDb::with_account("a").await;
        let now = 1_800_000_000_000;
        let day = local_day(now - DAY_MS);
        let row = UsageRow {
            kind: "key".into(),
            name: "go.inbox".into(),
            count: 1,
            ms: 0,
        };
        db::usage::add(&db.pool, &day, &[row]).await.unwrap();
        let refused = usage_server(404).await;
        let url = format!("{}/v1/usage", refused.uri());

        assert!(send_usage(&db.pool, &url, now).await.is_err());
        assert_eq!(
            db::usage::days_before(&db.pool, "9999").await.unwrap(),
            [day]
        );

        let later = now + (KEEP_UNSENT_DAYS + 2) * DAY_MS;
        assert_eq!(send_usage(&db.pool, &url, later).await.unwrap(), 0);
        assert!(db::usage::days_before(&db.pool, "9999")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn turned_off_records_nothing_and_forgets_what_waited() {
        let db = TestDb::with_account("a").await;
        let now = 1_800_000_000_000;
        let one = batch(serde_json::json!({
            "commands": [{ "id": "go.inbox", "source": "key", "count": 1 }],
            "rebound": [{ "id": "go.inbox", "key": "g h" }],
        }));
        record(&db.pool, &one, now).await.unwrap();
        db::settings::set_telemetry(&db.pool, false).await.unwrap();
        assert!(db::usage::days_before(&db.pool, "9999")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(db::settings::usage_rebound(&db.pool).await.unwrap(), None);

        record(&db.pool, &one, now).await.unwrap();
        assert!(db::usage::days_before(&db.pool, "9999")
            .await
            .unwrap()
            .is_empty());
        let server = usage_server(204).await;
        let url = format!("{}/v1/usage", server.uri());
        assert_eq!(
            send_usage(&db.pool, &url, now + 2 * DAY_MS).await.unwrap(),
            0
        );
    }

    #[test]
    fn names_windows_11_by_build() {
        assert_eq!(windows_name(10, 0, 26100), "Windows 11 (10.0.26100)");
        assert_eq!(windows_name(10, 0, 19045), "Windows 10 (10.0.19045)");
    }

    #[test]
    fn reads_the_linux_distribution() {
        let ubuntu = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n";
        assert_eq!(linux_name(ubuntu).as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(
            linux_name("NAME=Fedora\nVERSION_ID=41\n").as_deref(),
            Some("Fedora 41")
        );
        assert_eq!(linux_name("ID=arch\n"), None);
    }

    #[test]
    fn fields_fit_the_worker_limits() {
        assert_eq!(field("macOS\n15.1"), "macOS15.1");
        assert_eq!(field(&"x".repeat(300)).len(), MAX_FIELD_CHARS);
        assert_eq!(field("\u{7}"), "unknown");
    }
}
