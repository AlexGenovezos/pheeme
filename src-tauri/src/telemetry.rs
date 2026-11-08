//! Anonymous usage ping: once a day, a random install ID plus the Pheeme version, OS and
//! chip type go to the diagnostics Worker, so the developer can count active installs and
//! see what they run on. Nothing about the user, their accounts or their mail is sent.
//!
//! On by default; Settings › Diagnostics and the welcome screen turn it off, which also
//! forgets the install ID. Nothing is sent until an account is connected, so someone who
//! turns it off on the welcome screen is never counted. Debug builds never ping unless
//! `PHEEME_TELEMETRY_URL` is set.

use crate::db;
use crate::sync::engine::now_ms;
use serde::Serialize;
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

/// Check after launch, then every [`CHECK_EVERY`] while the app runs.
pub async fn run(db: SqlitePool) {
    let url = telemetry_url();
    tokio::time::sleep(FIRST_CHECK_AFTER).await;
    loop {
        match tick(&db, &url, now_ms()).await {
            Ok(true) => tracing::info!("sent the daily anonymous usage ping"),
            Ok(false) => {}
            Err(error) => tracing::debug!(%error, "anonymous usage ping failed"),
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
    let http = crate::http::client_builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("pheeme/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let response = http
        .post(url)
        .json(ping)
        .send()
        .await
        .map_err(|e| e.without_url())?;
    let status = response.status();
    anyhow::ensure!(status.is_success(), "ping refused ({status})");
    Ok(())
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

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

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
