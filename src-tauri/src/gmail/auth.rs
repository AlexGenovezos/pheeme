//! OAuth 2.0 for installed apps: PKCE (S256) with a loopback redirect, as Google
//! documents for desktop clients. Tauri-free so it can be tested and reused.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use reqwest::Url;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// The narrowest scopes v1 needs. Never request `https://mail.google.com/`.
/// `gmail.settings.basic` is for sender rules (Gmail filters); it's optional, see [`REQUIRED_SCOPE`].
pub const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
];

/// Google's consent screen lets users untick scopes; without this one the app is useless.
pub const REQUIRED_SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify";

#[derive(Clone, Debug)]
pub struct Endpoints {
    pub auth: String,
    pub token: String,
    pub userinfo: String,
    pub revoke: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            userinfo: "https://www.googleapis.com/oauth2/v3/userinfo".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ClientCredentials {
    pub client_id: String,
    pub client_secret: String,
}

impl std::fmt::Debug for ClientCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientCredentials")
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .finish()
    }
}

/// OAuth failures, each with a plain-language explanation and fix.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OAuthError {
    #[error("Google didn't grant access. If you clicked Cancel, start again. If Google said the app is still being tested, publish it to In production on the Audience page, or add your address as a test user.")]
    AccessDenied,
    #[error("This OAuth client only allows accounts from its own Google Workspace organization. Sign in with an account from that organization, or use an OAuth client from a project whose audience is External.")]
    OrgInternal,
    #[error("Your Google Workspace administrator blocks this app. Ask them to trust your OAuth client ID (Admin console → Security → API controls), or create the Google Cloud project inside your organization.")]
    AdminPolicyEnforced,
    #[error("Google didn't accept the client ID or secret. Copy both again from the Clients page in Google Cloud Console, and check that the client type is Desktop app.")]
    InvalidClient,
    #[error("This OAuth client isn't a Desktop app client. Create a new client with application type Desktop app and use its ID and secret.")]
    RedirectUriMismatch,
    #[error("Google signed Pheeme out of this account. Sign in again to reconnect it; its mail stays. Google does this when access is revoked, the password changes or the account is locked. If it happens every 7 days, your Google Cloud app is still in Testing: publish it to In production.")]
    InvalidGrant,
    #[error("The sign-in code expired or was already used. Start again.")]
    CodeRejected,
    #[error("Pheeme needs permission to read and organize your mail. Sign in again and leave the Gmail box ticked on Google's consent screen.")]
    MissingScope,
    #[error("Google didn't return a lasting sign-in. Remove Pheeme at myaccount.google.com/permissions, then sign in again.")]
    NoRefreshToken,
    #[error("Sign-in timed out. Start again when you're ready.")]
    Timeout,
    #[error("Sign-in was cancelled.")]
    Cancelled,
    #[error("Couldn't reach Google ({0}). Check your connection and try again.")]
    Network(String),
    #[error("Google returned an error: {code}{}", .description.as_deref().map(|d| format!(" ({d})")).unwrap_or_default())]
    Google {
        code: String,
        description: Option<String>,
    },
}

impl OAuthError {
    /// Maps an OAuth `error` code (from the redirect or the token endpoint).
    pub fn from_google(code: &str, description: Option<String>) -> Self {
        match code {
            "access_denied" => Self::AccessDenied,
            "org_internal" => Self::OrgInternal,
            "admin_policy_enforced" => Self::AdminPolicyEnforced,
            "invalid_client" | "unauthorized_client" | "deleted_client" | "disabled_client" => {
                Self::InvalidClient
            }
            "redirect_uri_mismatch" => Self::RedirectUriMismatch,
            "invalid_grant" => Self::InvalidGrant,
            _ => Self::Google {
                code: code.to_owned(),
                description,
            },
        }
    }

    /// Stable machine-readable code the frontend keys troubleshooting on.
    pub fn code(&self) -> &str {
        match self {
            Self::AccessDenied => "access_denied",
            Self::OrgInternal => "org_internal",
            Self::AdminPolicyEnforced => "admin_policy_enforced",
            Self::InvalidClient => "invalid_client",
            Self::RedirectUriMismatch => "redirect_uri_mismatch",
            Self::InvalidGrant => "invalid_grant",
            Self::CodeRejected => "code_rejected",
            Self::MissingScope => "missing_scope",
            Self::NoRefreshToken => "no_refresh_token",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::Network(_) => "network",
            Self::Google { .. } => "google_error",
        }
    }
}

fn network(error: reqwest::Error) -> OAuthError {
    OAuthError::Network(error.without_url().to_string())
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn generate() -> Self {
        Self::from_verifier(random_token())
    }

    /// RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))), unpadded.
    pub fn from_verifier(verifier: String) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

pub fn authorization_url(
    endpoints: &Endpoints,
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
    login_hint: Option<&str>,
) -> String {
    let mut url = Url::parse(&endpoints.auth).expect("auth endpoint is a valid URL");
    let mut query = url.query_pairs_mut();
    query
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &SCOPES.join(" "))
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        // Offline access plus forced consent guarantees a refresh token, including
        // when an account is re-added; select_account lets the user pick a second account.
        .append_pair("access_type", "offline")
        .append_pair("prompt", "select_account consent");
    // Reconnecting an account preselects it on Google's account chooser.
    if let Some(email) = login_hint {
        query.append_pair("login_hint", email);
    }
    drop(query);
    url.into()
}

/// Outcome of one request to the loopback listener. `None` means "not our
/// callback" (a favicon request, a stray or forged hit without our state).
pub fn parse_callback(target: &str, expected_state: &str) -> Option<Result<String, OAuthError>> {
    if !target.starts_with('/') {
        return None;
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if param("state")? != expected_state {
        return None;
    }
    if let Some(error) = param("error") {
        return Some(Err(OAuthError::from_google(
            &error,
            param("error_description"),
        )));
    }
    param("code").map(Ok)
}

/// A one-shot local HTTP listener for Google's redirect.
pub struct Loopback {
    listener: TcpListener,
    pub redirect_uri: String,
}

impl Loopback {
    /// Google recommends the literal loopback IP over `localhost`; any port is allowed.
    pub async fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        Ok(Self {
            listener,
            redirect_uri: format!("http://127.0.0.1:{port}/oauth/callback"),
        })
    }

    /// Serves requests until one carries our `state`, then returns its code or error.
    pub async fn wait_for_code(
        self,
        state: String,
        timeout: Duration,
    ) -> Result<String, OAuthError> {
        let (tx, mut rx) = mpsc::channel(1);
        let accept = async {
            loop {
                let Ok((stream, _)) = self.listener.accept().await else {
                    continue;
                };
                // Browsers open speculative connections that may never send a
                // request, so each connection gets its own task.
                tokio::spawn(serve_connection(stream, state.clone(), tx.clone()));
            }
        };
        tokio::select! {
            _ = accept => unreachable!("accept loop never ends"),
            result = rx.recv() => result.expect("sender held by accept loop"),
            _ = tokio::time::sleep(timeout) => Err(OAuthError::Timeout),
        }
    }
}

const PAGE_DONE: &str =
    "Pheeme received your sign-in. You can close this tab and go back to Pheeme.";
const PAGE_ERROR: &str = "Sign-in didn't finish. Go back to Pheeme to see what happened.";

async fn serve_connection(
    mut stream: TcpStream,
    state: String,
    tx: mpsc::Sender<Result<String, OAuthError>>,
) {
    let Ok(Some(target)) =
        tokio::time::timeout(Duration::from_secs(30), read_request_target(&mut stream)).await
    else {
        return;
    };
    let outcome = parse_callback(&target, &state);
    let (status, body) = match &outcome {
        Some(Ok(_)) => ("200 OK", PAGE_DONE),
        Some(Err(_)) => ("200 OK", PAGE_ERROR),
        None => ("404 Not Found", "Not found."),
    };
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>Pheeme</title>\
         <body style=\"font:16px system-ui;margin:20vh auto;max-width:28em;text-align:center\">\
         <p>{body}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    if let Some(result) = outcome {
        let _ = tx.try_send(result);
    }
}

/// Reads the request line's target (`/oauth/callback?code=...`), ignoring headers.
async fn read_request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(2).any(|w| w == b"\r\n") {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 || buf.len() > 16 * 1024 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let line = String::from_utf8_lossy(&buf);
    let mut parts = line.lines().next()?.split_whitespace();
    (parts.next()? == "GET").then_some(())?;
    parts.next().map(str::to_owned)
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_in: u64,
    pub refresh_token: Option<String>,
    pub scope: Option<String>,
}

impl TokenResponse {
    pub fn has_scope(&self, scope: &str) -> bool {
        // Google always reports granted scopes; treat a missing field as "as requested".
        self.scope
            .as_deref()
            .is_none_or(|granted| granted.split_whitespace().any(|s| s == scope))
    }
}

#[derive(Debug, Deserialize)]
struct GoogleErrorBody {
    error: String,
    error_description: Option<String>,
}

async fn token_request(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    form: &[(&str, &str)],
) -> Result<TokenResponse, OAuthError> {
    let response = http
        .post(&endpoints.token)
        .form(form)
        .send()
        .await
        .map_err(network)?;
    if response.status().is_success() {
        return response.json().await.map_err(network);
    }
    let status = response.status();
    match response.json::<GoogleErrorBody>().await {
        Ok(body) => Err(OAuthError::from_google(&body.error, body.error_description)),
        Err(_) => Err(OAuthError::Google {
            code: status.as_u16().to_string(),
            description: status.canonical_reason().map(str::to_owned),
        }),
    }
}

pub async fn exchange_code(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    creds: &ClientCredentials,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, OAuthError> {
    let result = token_request(
        http,
        endpoints,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("client_id", &creds.client_id),
            ("client_secret", &creds.client_secret),
        ],
    )
    .await;
    // On a code exchange, invalid_grant means the code (not a refresh token) is bad.
    match result {
        Err(OAuthError::InvalidGrant) => Err(OAuthError::CodeRejected),
        other => other,
    }
}

pub async fn refresh(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    creds: &ClientCredentials,
    refresh_token: &str,
) -> Result<TokenResponse, OAuthError> {
    token_request(
        http,
        endpoints,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", &creds.client_id),
            ("client_secret", &creds.client_secret),
        ],
    )
    .await
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct UserInfo {
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

pub async fn user_info(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    access_token: &str,
) -> Result<UserInfo, OAuthError> {
    let response = http
        .get(&endpoints.userinfo)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(network)?;
    if !response.status().is_success() {
        return Err(OAuthError::Google {
            code: response.status().as_u16().to_string(),
            description: Some("couldn't read the account's email address".into()),
        });
    }
    response.json().await.map_err(network)
}

/// Revokes the grant behind `token`. Callers treat failure as non-fatal.
pub async fn revoke(
    http: &reqwest::Client,
    endpoints: &Endpoints,
    token: &str,
) -> Result<(), OAuthError> {
    http.post(&endpoints.revoke)
        .form(&[("token", token)])
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map(drop)
        .map_err(network)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn endpoints(server: &MockServer) -> Endpoints {
        Endpoints {
            auth: format!("{}/auth", server.uri()),
            token: format!("{}/token", server.uri()),
            userinfo: format!("{}/userinfo", server.uri()),
            revoke: format!("{}/revoke", server.uri()),
        }
    }

    fn creds() -> ClientCredentials {
        ClientCredentials {
            client_id: "id.apps.googleusercontent.com".into(),
            client_secret: "s3cret".into(),
        }
    }

    #[test]
    fn pkce_matches_rfc7636_example() {
        // RFC 7636 Appendix B.
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
        assert_eq!(
            pkce.challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pkce_verifier_is_random_and_valid_length() {
        let a = Pkce::generate();
        let b = Pkce::generate();
        assert_ne!(a.verifier, b.verifier);
        // RFC 7636: 43..=128 unreserved characters.
        assert!((43..=128).contains(&a.verifier.len()));
        assert!(a
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
    }

    #[test]
    fn authorization_url_has_pkce_scopes_and_offline_consent() {
        let url = authorization_url(
            &Endpoints::default(),
            "cid",
            "http://127.0.0.1:5000/oauth/callback",
            "chal",
            "st",
            None,
        );
        let url = Url::parse(&url).unwrap();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000/oauth/callback");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["prompt"], "select_account consent");
        assert_eq!(q["scope"], SCOPES.join(" "));
        assert!(!q["scope"].contains("https://mail.google.com/"));
        assert!(!q.contains_key("login_hint"));
    }

    #[test]
    fn parse_callback_cases() {
        assert_eq!(
            parse_callback("/oauth/callback?state=s&code=abc", "s"),
            Some(Ok("abc".into()))
        );
        assert_eq!(
            parse_callback("/oauth/callback?state=s&error=access_denied", "s"),
            Some(Err(OAuthError::AccessDenied))
        );
        // Wrong or missing state is not our callback; keep waiting.
        assert_eq!(
            parse_callback("/oauth/callback?state=x&code=abc", "s"),
            None
        );
        assert_eq!(parse_callback("/oauth/callback?code=abc", "s"), None);
        assert_eq!(parse_callback("/favicon.ico", "s"), None);
        assert_eq!(parse_callback("http://evil/?state=s&code=1", "s"), None);
        // State matches but neither code nor error.
        assert_eq!(parse_callback("/oauth/callback?state=s", "s"), None);
    }

    #[test]
    fn google_error_codes_map_to_plain_language() {
        for (code, expected) in [
            ("access_denied", OAuthError::AccessDenied),
            ("org_internal", OAuthError::OrgInternal),
            ("admin_policy_enforced", OAuthError::AdminPolicyEnforced),
            ("invalid_client", OAuthError::InvalidClient),
            ("deleted_client", OAuthError::InvalidClient),
            ("redirect_uri_mismatch", OAuthError::RedirectUriMismatch),
            ("invalid_grant", OAuthError::InvalidGrant),
        ] {
            let error = OAuthError::from_google(code, None);
            assert_eq!(error, expected);
            assert_eq!(
                error.code(),
                if code == "deleted_client" {
                    "invalid_client"
                } else {
                    code
                }
            );
        }
        let unknown = OAuthError::from_google("weird", Some("details".into()));
        assert_eq!(unknown.code(), "google_error");
        assert!(unknown.to_string().contains("weird (details)"));
        assert!(OAuthError::InvalidGrant.to_string().contains("7 days"));
        assert!(OAuthError::RedirectUriMismatch
            .to_string()
            .contains("Desktop app"));
    }

    #[test]
    fn credentials_debug_redacts_secret() {
        let out = format!("{:?}", creds());
        assert!(!out.contains("s3cret"));
        assert!(out.contains("id.apps.googleusercontent.com"));
    }

    async fn get(uri: &str) -> (u16, String) {
        let response = reqwest::get(uri).await.unwrap();
        (response.status().as_u16(), response.text().await.unwrap())
    }

    #[tokio::test]
    async fn loopback_returns_code_and_ignores_other_requests() {
        let loopback = Loopback::bind().await.unwrap();
        let base = loopback.redirect_uri.clone();
        assert!(base.starts_with("http://127.0.0.1:"));
        let wait = tokio::spawn(loopback.wait_for_code("st".into(), Duration::from_secs(10)));
        // An idle speculative connection must not block the real callback.
        let port = base.split(':').nth(2).unwrap().split('/').next().unwrap();
        let _idle = TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .unwrap();

        let origin = base.trim_end_matches("/oauth/callback");
        assert_eq!(get(&format!("{origin}/favicon.ico")).await.0, 404);
        assert_eq!(get(&format!("{base}?state=wrong&code=x")).await.0, 404);
        let (status, body) = get(&format!("{base}?state=st&code=the-code")).await;
        assert_eq!(status, 200);
        assert!(body.contains("close this tab"));
        assert_eq!(wait.await.unwrap(), Ok("the-code".into()));
    }

    #[tokio::test]
    async fn loopback_reports_google_error() {
        let loopback = Loopback::bind().await.unwrap();
        let base = loopback.redirect_uri.clone();
        let wait = tokio::spawn(loopback.wait_for_code("st".into(), Duration::from_secs(10)));
        let (_, body) = get(&format!("{base}?state=st&error=access_denied")).await;
        assert!(body.contains("didn't finish"));
        assert_eq!(wait.await.unwrap(), Err(OAuthError::AccessDenied));
    }

    #[tokio::test]
    async fn loopback_times_out() {
        let loopback = Loopback::bind().await.unwrap();
        let result = loopback
            .wait_for_code("st".into(), Duration::from_millis(50))
            .await;
        assert_eq!(result, Err(OAuthError::Timeout));
    }

    #[tokio::test]
    async fn exchange_code_posts_pkce_form() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .and(body_string_contains("code=c0de"))
            .and(body_string_contains("code_verifier=ver"))
            .and(body_string_contains("client_secret=s3cret"))
            .and(body_string_contains(
                "redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Foauth%2Fcallback",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "at", "expires_in": 3599, "refresh_token": "rt",
                "scope": SCOPES.join(" "), "token_type": "Bearer"
            })))
            .expect(1)
            .mount(&server)
            .await;
        let tokens = exchange_code(
            &reqwest::Client::new(),
            &endpoints(&server),
            &creds(),
            "c0de",
            "ver",
            "http://127.0.0.1:1/oauth/callback",
        )
        .await
        .unwrap();
        assert_eq!(tokens.access_token, "at");
        assert_eq!(tokens.refresh_token.as_deref(), Some("rt"));
        assert!(tokens.has_scope(REQUIRED_SCOPE));
    }

    #[tokio::test]
    async fn token_errors_map_from_google_bodies() {
        let server = MockServer::start().await;
        Mock::given(path("/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error": "invalid_grant"})),
            )
            .mount(&server)
            .await;
        Mock::given(path("/token"))
            .and(body_string_contains("refresh_token=dead"))
            .respond_with(
                ResponseTemplate::new(400).set_body_json(serde_json::json!({"error": "invalid_grant", "error_description": "Token has been expired or revoked."})),
            )
            .mount(&server)
            .await;
        Mock::given(path("/token"))
            .and(body_string_contains("refresh_token=badclient"))
            .respond_with(ResponseTemplate::new(401).set_body_json(
                serde_json::json!({"error": "invalid_client", "error_description": "Unauthorized"}),
            ))
            .mount(&server)
            .await;
        Mock::given(path("/token"))
            .and(body_string_contains("refresh_token=html"))
            .respond_with(ResponseTemplate::new(503).set_body_string("<html>"))
            .mount(&server)
            .await;
        let http = reqwest::Client::new();
        let ep = endpoints(&server);
        assert_eq!(
            exchange_code(&http, &ep, &creds(), "c", "v", "r")
                .await
                .unwrap_err(),
            OAuthError::CodeRejected
        );
        assert_eq!(
            refresh(&http, &ep, &creds(), "dead").await.unwrap_err(),
            OAuthError::InvalidGrant
        );
        assert_eq!(
            refresh(&http, &ep, &creds(), "badclient")
                .await
                .unwrap_err(),
            OAuthError::InvalidClient
        );
        assert_eq!(
            refresh(&http, &ep, &creds(), "html")
                .await
                .unwrap_err()
                .code(),
            "google_error"
        );
    }

    #[tokio::test]
    async fn network_failure_maps_to_network_error() {
        let ep = Endpoints {
            token: "http://127.0.0.1:1/token".into(),
            ..Endpoints::default()
        };
        let error = refresh(&reqwest::Client::new(), &ep, &creds(), "rt")
            .await
            .unwrap_err();
        assert_eq!(error.code(), "network");
    }

    #[tokio::test]
    async fn user_info_and_revoke() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/userinfo"))
            .and(header("authorization", "Bearer at"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sub": "1", "email": "a@example.com", "name": "A", "picture": "https://p"
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/revoke"))
            .and(body_string_contains("token=rt"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;
        let http = reqwest::Client::new();
        let ep = endpoints(&server);
        assert_eq!(
            user_info(&http, &ep, "at").await.unwrap(),
            UserInfo {
                email: "a@example.com".into(),
                name: Some("A".into()),
                picture: Some("https://p".into()),
            }
        );
        assert!(user_info(&http, &ep, "wrong").await.is_err());
        revoke(&http, &ep, "rt").await.unwrap();
    }

    #[test]
    fn has_scope_checks_granted_list() {
        let mut tokens = TokenResponse {
            access_token: "a".into(),
            expires_in: 1,
            refresh_token: None,
            scope: Some("https://www.googleapis.com/auth/userinfo.email".into()),
        };
        assert!(!tokens.has_scope(REQUIRED_SCOPE));
        tokens.scope = None;
        assert!(tokens.has_scope(REQUIRED_SCOPE));
    }
}
