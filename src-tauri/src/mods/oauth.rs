use super::OpenBrowser;
use super::{
    network,
    schema::{ensure, https_url, Connection},
};
use crate::{
    gmail::auth::{random_token, Pkce},
    secrets::Keychain,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

pub const REDIRECT: &str = "http://127.0.0.1:43821/callback";

#[derive(Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    pub client_id: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: String,
    scope: Option<String>,
}

fn key(mod_id: &str, connection: &str) -> String {
    format!("mod:{mod_id}:{connection}")
}

pub fn read(
    store: &dyn Keychain,
    mod_id: &str,
    connection: &str,
) -> Result<Option<Tokens>, String> {
    store
        .read(&key(mod_id, connection))
        .map_err(|_| "Could not read mod credentials from the system keychain")?
        .map(|json| {
            serde_json::from_str(&json).map_err(|_| {
                "Stored mod connection is unreadable; disconnect and connect again".into()
            })
        })
        .transpose()
}

pub fn disconnect(store: &dyn Keychain, mod_id: &str, connection: &str) -> Result<(), String> {
    store
        .delete(&key(mod_id, connection))
        .map_err(|_| "Could not delete mod credentials from the system keychain".into())
}

fn save(
    store: &dyn Keychain,
    mod_id: &str,
    connection: &str,
    tokens: &Tokens,
) -> Result<(), String> {
    let json = serde_json::to_string(tokens).map_err(|_| "Could not encode mod credentials")?;
    store
        .write(&key(mod_id, connection), &json)
        .map_err(|_| "Could not store mod credentials in the system keychain".into())
}

async fn exchange(
    connection: &Connection,
    form: &[(&str, &str)],
    client_id: &str,
    previous_refresh: Option<String>,
) -> Result<Tokens, String> {
    let url = https_url(&connection.token_url)?;
    exchange_with(
        network::client(&url).await?,
        url,
        connection,
        form,
        client_id,
        previous_refresh,
    )
    .await
}

async fn exchange_with(
    client: reqwest::Client,
    url: reqwest::Url,
    connection: &Connection,
    form: &[(&str, &str)],
    client_id: &str,
    previous_refresh: Option<String>,
) -> Result<Tokens, String> {
    let response = client
        .post(url)
        .form(form)
        .send()
        .await
        .map_err(|_| "Could not reach the connection's token endpoint")?;
    let response = network::read(response).await?;
    ensure(
        response.status == 200,
        "The provider rejected this login; check the client ID, redirect URI and granted scopes",
    )?;
    let response: TokenResponse = serde_json::from_str(&response.body)
        .map_err(|_| "The provider returned an invalid token response")?;
    ensure(
        !response.access_token.is_empty() && response.token_type.eq_ignore_ascii_case("bearer"),
        "The provider did not return a bearer token",
    )?;
    if let Some(scopes) = &response.scope {
        ensure(
            connection
                .scopes
                .iter()
                .all(|s| scopes.split_whitespace().any(|granted| granted == s)),
            "The provider did not grant all requested permissions",
        )?;
    }
    Ok(Tokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token.or(previous_refresh),
        expires_at: chrono::Utc::now().timestamp()
            + response.expires_in.unwrap_or(3600).min(31_536_000) as i64,
        client_id: client_id.into(),
    })
}

/// The caller owns cancellation. Dropping this future closes the callback listener;
/// credentials are committed only after the caller verifies its session is still live.
pub async fn connect(
    connection: &Connection,
    client_id: &str,
    open: OpenBrowser,
) -> Result<Tokens, String> {
    ensure(
        !client_id.trim().is_empty() && client_id.len() <= 200,
        "Enter the provider's public desktop client ID",
    )?;
    let listener = TcpListener::bind("127.0.0.1:43821").await.map_err(|_| {
        "The login callback port (43821) is busy; finish another login and try again"
    })?;
    let pkce = Pkce::generate();
    let state = random_token();
    let mut url = https_url(&connection.authorization_url)?;
    // Validate browser destinations too, without sending any credentials.
    network::client(&url).await?;
    ensure(
        url.query().is_none(),
        "Authorization endpoints must not contain query parameters",
    )?;
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", REDIRECT),
        ("scope", &connection.scopes.join(" ")),
        ("state", &state),
        ("code_challenge_method", "S256"),
        ("code_challenge", &pkce.challenge),
    ]);
    open(url.as_str())?;
    let code = receive_code(listener, &state).await?;
    exchange(
        connection,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("client_id", client_id),
            ("redirect_uri", REDIRECT),
            ("code_verifier", &pkce.verifier),
        ],
        client_id,
        None,
    )
    .await
}

async fn receive_code(listener: TcpListener, state: &str) -> Result<String, String> {
    tokio::time::timeout(Duration::from_secs(180), async {
        // Ignore unrelated browser requests, but cap attempts and every individual read.
        for _ in 0..12 {
            let (mut socket, _) = listener.accept().await.map_err(|_| "Login callback failed")?;
            let bytes = tokio::time::timeout(Duration::from_secs(2), async {
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0u8; 1024];
                    let n = socket.read(&mut chunk).await.map_err(|_| "Login callback failed")?;
                    if n == 0 { break; }
                    bytes.extend_from_slice(&chunk[..n]);
                    ensure(bytes.len() <= 8192, "Login callback is too large")?;
                    if bytes.windows(4).any(|part| part == b"\r\n\r\n") { break; }
                }
                Ok::<_, String>(bytes)
            }).await.map_err(|_| "Login callback timed out")??;
            let request = String::from_utf8_lossy(&bytes);
            let path = request.lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|line| line.split_once(' ')).map(|(path, _)| path).unwrap_or("");
            let result = callback(path, state);
            let (status, message) = if result.is_ok() { ("200 OK", "Connected. You can return to Pheeme.") } else { ("400 Bad Request", "Login was not accepted. Return to Pheeme and try again.") };
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}", message.len());
            let _ = tokio::time::timeout(Duration::from_secs(1), socket.write_all(response.as_bytes())).await;
            match result { Ok(code) => return Ok(code), Err(error) if error == "Provider denied login" => return Err(error), Err(_) => {} }
        }
        Err("No valid login callback received".into())
    }).await.map_err(|_| "Login timed out; try connecting again")?
}

fn callback(path: &str, state: &str) -> Result<String, String> {
    ensure(path.starts_with("/callback?"), "Unexpected login callback")?;
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{path}"))
        .map_err(|_| "Invalid login callback")?;
    let pairs: Vec<_> = url.query_pairs().collect();
    ensure(
        pairs.iter().filter(|(k, _)| k == "state").count() == 1
            && pairs.iter().any(|(k, v)| k == "state" && v == state),
        "Login state did not match",
    )?;
    ensure(
        !pairs.iter().any(|(k, _)| k == "error"),
        "Provider denied login",
    )?;
    ensure(
        pairs.iter().filter(|(k, _)| k == "code").count() == 1,
        "Missing login code",
    )?;
    pairs
        .into_iter()
        .find(|(k, v)| k == "code" && !v.is_empty())
        .map(|(_, v)| v.into_owned())
        .ok_or("Missing login code".into())
}

pub fn commit(
    store: &dyn Keychain,
    mod_id: &str,
    connection: &str,
    tokens: &Tokens,
) -> Result<(), String> {
    save(store, mod_id, connection, tokens)
}

pub async fn refresh(connection: &Connection, tokens: Tokens) -> Result<Tokens, String> {
    let refresh = tokens
        .refresh_token
        .as_deref()
        .ok_or("This connection expired; connect again in Settings")?;
    exchange(
        connection,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", &tokens.client_id),
        ],
        &tokens.client_id,
        tokens.refresh_token.clone(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        matchers::{body_string_contains, method, path},
        Mock, MockServer, ResponseTemplate,
    };
    #[test]
    fn callback_checks_path_state_duplicates_and_errors() {
        assert_eq!(
            callback("/callback?state=right&code=ok", "right").unwrap(),
            "ok"
        );
        for path in [
            "/else?state=right&code=x",
            "/callback?state=wrong&code=x",
            "/callback?state=right&state=right&code=x",
            "/callback?state=right&code=x&code=y",
            "/callback?state=right&error=denied",
        ] {
            assert!(callback(path, "right").is_err());
        }
    }

    #[tokio::test]
    async fn fake_provider_exchange_refresh_scopes_redaction_and_redirects() {
        let server = MockServer::start().await;
        let connection: Connection = serde_json::from_value(serde_json::json!({
            "id":"test", "name":"Test", "authorizationUrl":"https://example.com/auth", "tokenUrl":"https://example.com/token", "scopes":["read"], "apiOrigins":["https://example.com"]
        })).unwrap();
        let client = crate::http::client_builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let url = reqwest::Url::parse(&format!("{}/token", server.uri())).unwrap();
        Mock::given(method("POST")).and(path("/token")).and(body_string_contains("code_verifier=proof"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"access_token":"access", "refresh_token":"refresh", "token_type":"Bearer", "scope":"read", "expires_in":3600}))).expect(1).mount(&server).await;
        let tokens = exchange_with(
            client.clone(),
            url.clone(),
            &connection,
            &[("code_verifier", "proof")],
            "client",
            None,
        )
        .await
        .unwrap();
        assert_eq!(tokens.refresh_token.as_deref(), Some("refresh"));
        assert!(tokens.expires_at > chrono::Utc::now().timestamp());
        server.reset().await;
        Mock::given(method("POST")).and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"access_token":"new-access", "token_type":"Bearer", "scope":"read"}))).mount(&server).await;
        let refreshed = exchange_with(
            client.clone(),
            url.clone(),
            &connection,
            &[("grant_type", "refresh_token")],
            "client",
            tokens.refresh_token,
        )
        .await
        .unwrap();
        assert_eq!(refreshed.access_token, "new-access");
        assert_eq!(refreshed.refresh_token.as_deref(), Some("refresh"));
        server.reset().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"access_token":"secret", "token_type":"Bearer", "scope":"different"}))).mount(&server).await;
        let error = exchange_with(
            client.clone(),
            url.clone(),
            &connection,
            &[],
            "client",
            None,
        )
        .await
        .err()
        .unwrap();
        assert!(!error.contains("secret"));
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("Location", format!("{}/leak", server.uri())),
            )
            .mount(&server)
            .await;
        assert!(exchange_with(client, url, &connection, &[], "client", None)
            .await
            .is_err());
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            1,
            "token redirects must not be followed"
        );
    }

    #[tokio::test]
    async fn callback_accepts_fragmented_http_and_dropping_it_closes_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let flow = tokio::spawn(receive_code(listener, "expected"));
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket
            .write_all(b"GET /callback?state=expected&co")
            .await
            .unwrap();
        tokio::task::yield_now().await;
        socket
            .write_all(b"de=code HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        assert_eq!(flow.await.unwrap().unwrap(), "code");
        let listener = TcpListener::bind(address).await.unwrap();
        let flow = tokio::spawn(receive_code(listener, "another"));
        flow.abort();
        let _ = flow.await;
        assert!(TcpListener::bind(address).await.is_ok());
    }
}
