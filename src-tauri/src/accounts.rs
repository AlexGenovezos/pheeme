//! Account sign-in, listing, removal and access tokens. Tauri-free: commands are
//! thin adapters over [`AccountService`].
//!
//! Secrets (client secret, refresh token) live only in the OS keychain. Access
//! tokens live only in memory: they expire within an hour, so persisting them
//! would add keychain writes without saving a meaningful number of refreshes.

use crate::db::accounts::{self as db_accounts, DbAccount};
use crate::gmail::auth::{self, ClientCredentials, Endpoints, Loopback, OAuthError, Pkce};
use crate::secrets::{AccountSecrets, SecretStore, SecretsError};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tokio::task::{AbortHandle, JoinHandle};

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const REVOKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Refresh a little early so a token never expires mid-request.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error(transparent)]
    OAuth(#[from] OAuthError),
    #[error(transparent)]
    Secrets(#[from] SecretsError),
    #[error("{0}")]
    Invalid(String),
    #[error("That account isn't connected any more.")]
    NotFound,
    #[error("No sign-in is in progress. Start again.")]
    NoSignIn,
    #[error("Pheeme has no saved sign-in for this account. Sign in again.")]
    NoSavedSignIn,
    #[error("Something went wrong: {0}")]
    Internal(String),
}

impl AccountError {
    pub fn code(&self) -> &str {
        match self {
            Self::OAuth(error) => error.code(),
            Self::Secrets(SecretsError::Unavailable(_)) => "keychain_unavailable",
            Self::Secrets(SecretsError::Corrupt) => "keychain_corrupt",
            Self::Secrets(SecretsError::Other(_)) => "keychain_error",
            Self::Invalid(_) => "invalid_input",
            Self::NotFound => "not_found",
            Self::NoSignIn => "no_sign_in",
            Self::NoSavedSignIn => "no_saved_sign_in",
            Self::Internal(_) => "internal",
        }
    }
}

impl From<anyhow::Error> for AccountError {
    fn from(error: anyhow::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

/// Which OAuth client a sign-in uses.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClientChoice {
    /// Freshly pasted credentials.
    #[serde(rename_all = "camelCase")]
    New {
        client_id: String,
        client_secret: String,
    },
    /// Reuse the client an existing account signed in with.
    #[serde(rename_all = "camelCase")]
    SameAs { account_id: String },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignInStart {
    pub flow_id: String,
    pub auth_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub client_id: String,
}

impl From<DbAccount> for AccountInfo {
    fn from(account: DbAccount) -> Self {
        Self {
            id: account.id,
            email: account.email,
            display_name: account.display_name,
            client_id: account.client_id,
        }
    }
}

struct PendingSignIn {
    flow_id: String,
    creds: ClientCredentials,
    verifier: String,
    redirect_uri: String,
    callback: JoinHandle<Result<String, OAuthError>>,
}

pub struct AccountService {
    db: SqlitePool,
    secrets: Arc<dyn SecretStore>,
    http: reqwest::Client,
    endpoints: Endpoints,
    sign_in_timeout: Duration,
    /// The sign-in waiting for `complete_sign_in`. At most one at a time.
    pending: Mutex<Option<PendingSignIn>>,
    /// Lets `cancel_sign_in` stop the callback wait even after `complete_sign_in` took it.
    active: Mutex<Option<(String, AbortHandle)>>,
    tokens: Mutex<HashMap<String, (String, Instant)>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn validate_new_client(
    client_id: &str,
    client_secret: &str,
) -> Result<ClientCredentials, AccountError> {
    let client_id = client_id.trim();
    let client_secret = client_secret.trim();
    if !client_id.ends_with(".apps.googleusercontent.com")
        || client_id.contains(char::is_whitespace)
    {
        return Err(AccountError::Invalid(
            "That doesn't look like a client ID. It ends in .apps.googleusercontent.com.".into(),
        ));
    }
    if client_secret.is_empty() {
        return Err(AccountError::Invalid("Paste the client secret too.".into()));
    }
    Ok(ClientCredentials {
        client_id: client_id.to_owned(),
        client_secret: client_secret.to_owned(),
    })
}

impl AccountService {
    pub fn new(db: SqlitePool, secrets: Arc<dyn SecretStore>) -> Self {
        Self::with_endpoints(db, secrets, Endpoints::default(), SIGN_IN_TIMEOUT)
    }

    pub fn with_endpoints(
        db: SqlitePool,
        secrets: Arc<dyn SecretStore>,
        endpoints: Endpoints,
        sign_in_timeout: Duration,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client builds with static config");
        Self {
            db,
            secrets,
            http,
            endpoints,
            sign_in_timeout,
            pending: Mutex::new(None),
            active: Mutex::new(None),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Keychain calls can block on an OS prompt, so they run off the async threads.
    async fn keychain<T: Send + 'static>(
        &self,
        op: impl FnOnce(&dyn SecretStore) -> Result<T, SecretsError> + Send + 'static,
    ) -> Result<T, AccountError> {
        let store = Arc::clone(&self.secrets);
        tokio::task::spawn_blocking(move || op(store.as_ref()))
            .await
            .map_err(|error| AccountError::Internal(error.to_string()))?
            .map_err(Into::into)
    }

    async fn account(&self, account_id: &str) -> Result<DbAccount, AccountError> {
        db_accounts::get_account(&self.db, account_id)
            .await?
            .ok_or(AccountError::NotFound)
    }

    async fn saved_credentials(
        &self,
        account: &DbAccount,
    ) -> Result<(ClientCredentials, String), AccountError> {
        let id = account.id.clone();
        let secrets = self
            .keychain(move |store| store.get(&id))
            .await?
            .ok_or(AccountError::NoSavedSignIn)?;
        Ok((
            ClientCredentials {
                client_id: account.client_id.clone(),
                client_secret: secrets.client_secret,
            },
            secrets.refresh_token,
        ))
    }

    /// Starts listening for Google's redirect and returns the URL to open in the browser.
    /// Starting a new sign-in abandons any earlier one.
    pub async fn begin_sign_in(&self, choice: ClientChoice) -> Result<SignInStart, AccountError> {
        let creds = match choice {
            ClientChoice::New {
                client_id,
                client_secret,
            } => validate_new_client(&client_id, &client_secret)?,
            ClientChoice::SameAs { account_id } => {
                let account = self.account(&account_id).await?;
                self.saved_credentials(&account).await?.0
            }
        };

        let loopback = Loopback::bind().await.map_err(|error| {
            AccountError::Internal(format!("couldn't open a local port: {error}"))
        })?;
        let pkce = Pkce::generate();
        let state = auth::random_token();
        let flow_id = uuid::Uuid::new_v4().to_string();
        let auth_url = auth::authorization_url(
            &self.endpoints,
            &creds.client_id,
            &loopback.redirect_uri,
            &pkce.challenge,
            &state,
        );
        let redirect_uri = loopback.redirect_uri.clone();
        let callback = tokio::spawn(loopback.wait_for_code(state, self.sign_in_timeout));

        if let Some((_, previous)) =
            lock(&self.active).replace((flow_id.clone(), callback.abort_handle()))
        {
            previous.abort();
        }
        *lock(&self.pending) = Some(PendingSignIn {
            flow_id: flow_id.clone(),
            creds,
            verifier: pkce.verifier,
            redirect_uri,
            callback,
        });
        Ok(SignInStart { flow_id, auth_url })
    }

    pub fn cancel_sign_in(&self, flow_id: &str) {
        let mut active = lock(&self.active);
        if active.as_ref().is_some_and(|(id, _)| id == flow_id) {
            if let Some((_, handle)) = active.take() {
                handle.abort();
            }
        }
    }

    /// Waits for the browser redirect, then exchanges the code and saves the account.
    pub async fn complete_sign_in(&self, flow_id: &str) -> Result<AccountInfo, AccountError> {
        let pending = {
            let mut slot = lock(&self.pending);
            match slot.take() {
                Some(pending) if pending.flow_id == flow_id => pending,
                other => {
                    *slot = other;
                    return Err(AccountError::NoSignIn);
                }
            }
        };
        let code = match pending.callback.await {
            Ok(result) => result?,
            Err(error) if error.is_cancelled() => return Err(OAuthError::Cancelled.into()),
            Err(error) => return Err(AccountError::Internal(error.to_string())),
        };

        let tokens = auth::exchange_code(
            &self.http,
            &self.endpoints,
            &pending.creds,
            &code,
            &pending.verifier,
            &pending.redirect_uri,
        )
        .await?;
        if !tokens.has_scope(auth::REQUIRED_SCOPE) {
            return Err(OAuthError::MissingScope.into());
        }
        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or(OAuthError::NoRefreshToken)?;
        let profile = auth::user_info(&self.http, &self.endpoints, &tokens.access_token).await?;

        // A flow cancelled or replaced while talking to Google must not save anything.
        {
            let mut active = lock(&self.active);
            if !active.as_ref().is_some_and(|(id, _)| id == flow_id) {
                return Err(OAuthError::Cancelled.into());
            }
            *active = None;
        }

        let account = self
            .save_account(&profile, &pending.creds, refresh_token)
            .await?;
        self.cache_token(&account.id, tokens.access_token, tokens.expires_in);
        Ok(account.into())
    }

    /// Signing in to an account that's already connected updates it in place, keeping
    /// its id (and cached mail); it may switch to a different OAuth client.
    async fn save_account(
        &self,
        profile: &auth::UserInfo,
        creds: &ClientCredentials,
        refresh_token: String,
    ) -> Result<DbAccount, AccountError> {
        let existing = db_accounts::get_account_by_email(&self.db, &profile.email).await?;
        let id = existing
            .as_ref()
            .map(|account| account.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let secrets = AccountSecrets {
            client_secret: creds.client_secret.clone(),
            refresh_token,
        };
        let key = id.clone();
        self.keychain(move |store| store.put(&key, &secrets))
            .await?;

        let timestamp = now();
        let saved = match existing {
            Some(_) => {
                async {
                    db_accounts::update_client_id(&self.db, &id, &creds.client_id, timestamp)
                        .await?;
                    db_accounts::update_profile(
                        &self.db,
                        &id,
                        profile.name.as_deref(),
                        profile.picture.as_deref(),
                        timestamp,
                    )
                    .await
                }
                .await
            }
            None => {
                let inserted = db_accounts::insert_account(
                    &self.db,
                    &DbAccount {
                        id: id.clone(),
                        email: profile.email.clone(),
                        display_name: profile.name.clone(),
                        profile_photo_url: profile.picture.clone(),
                        client_id: creds.client_id.clone(),
                        history_id: None,
                        created_at: timestamp,
                        updated_at: timestamp,
                    },
                )
                .await;
                if inserted.is_err() {
                    // Don't leave a secret behind for an account that doesn't exist.
                    let key = id.clone();
                    let _ = self.keychain(move |store| store.delete(&key)).await;
                }
                inserted
            }
        };
        saved?;
        self.account(&id).await
    }

    pub async fn list_accounts(&self) -> Result<Vec<AccountInfo>, AccountError> {
        Ok(db_accounts::list_accounts(&self.db)
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// Revokes Google access (best effort), then deletes the secrets and all cached data.
    pub async fn remove_account(&self, account_id: &str) -> Result<(), AccountError> {
        self.account(account_id).await?;
        let id = account_id.to_owned();
        if let Some(secrets) = self.keychain(move |store| store.get(&id)).await? {
            let revoke = auth::revoke(&self.http, &self.endpoints, &secrets.refresh_token);
            if let Ok(Err(error)) | Err(error) = tokio::time::timeout(REVOKE_TIMEOUT, revoke)
                .await
                .map_err(|_| OAuthError::Timeout)
            {
                tracing::warn!("couldn't revoke Google access for {account_id}: {error}");
            }
        }
        let id = account_id.to_owned();
        self.keychain(move |store| store.delete(&id)).await?;
        db_accounts::delete_account(&self.db, account_id).await?;
        lock(&self.tokens).remove(account_id);
        Ok(())
    }

    fn cache_token(&self, account_id: &str, token: String, expires_in: u64) {
        let expires_at = Instant::now() + Duration::from_secs(expires_in);
        lock(&self.tokens).insert(account_id.to_owned(), (token, expires_at));
    }

    /// A valid access token for API calls, refreshing it when it's about to expire.
    pub async fn access_token(&self, account_id: &str) -> Result<String, AccountError> {
        if let Some((token, expires_at)) = lock(&self.tokens).get(account_id) {
            if *expires_at > Instant::now() + EXPIRY_MARGIN {
                return Ok(token.clone());
            }
        }
        self.refresh_access_token(account_id).await
    }

    /// Exchanges the stored refresh token for a new access token.
    pub async fn refresh_access_token(&self, account_id: &str) -> Result<String, AccountError> {
        let account = self.account(account_id).await?;
        let (creds, refresh_token) = self.saved_credentials(&account).await?;
        let tokens = auth::refresh(&self.http, &self.endpoints, &creds, &refresh_token).await?;
        if let Some(rotated) = tokens.refresh_token.filter(|token| *token != refresh_token) {
            let secrets = AccountSecrets {
                client_secret: creds.client_secret,
                refresh_token: rotated,
            };
            let id = account_id.to_owned();
            self.keychain(move |store| store.put(&id, &secrets)).await?;
        }
        self.cache_token(account_id, tokens.access_token.clone(), tokens.expires_in);
        Ok(tokens.access_token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;
    use reqwest::Url;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const CLIENT_A: &str = "a.apps.googleusercontent.com";
    const CLIENT_B: &str = "b.apps.googleusercontent.com";

    struct Harness {
        service: AccountService,
        secrets: Arc<MemoryStore>,
        server: MockServer,
    }

    async fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let db = crate::db::init_db(dir.path()).await.unwrap();
        std::mem::forget(dir);
        let server = MockServer::start().await;
        let secrets = Arc::new(MemoryStore::new());
        let endpoints = Endpoints {
            auth: format!("{}/auth", server.uri()),
            token: format!("{}/token", server.uri()),
            userinfo: format!("{}/userinfo", server.uri()),
            revoke: format!("{}/revoke", server.uri()),
        };
        let service =
            AccountService::with_endpoints(db, secrets.clone(), endpoints, Duration::from_secs(10));
        Harness {
            service,
            secrets,
            server,
        }
    }

    fn token_body(refresh: Option<&str>, scope: &str) -> serde_json::Value {
        let mut body = serde_json::json!({
            "access_token": "access-1", "expires_in": 3600, "scope": scope, "token_type": "Bearer"
        });
        if let Some(refresh) = refresh {
            body["refresh_token"] = refresh.into();
        }
        body
    }

    async fn mock_google(server: &MockServer, email: &str, refresh: &str) {
        server.reset().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(token_body(Some(refresh), &auth::SCOPES.join(" "))),
            )
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/userinfo"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"email": email, "name": "Test User"})),
            )
            .mount(server)
            .await;
    }

    /// Plays the browser: follows the auth URL's redirect_uri with a code.
    async fn approve(start: &SignInStart, code: &str) {
        let url = Url::parse(&start.auth_url).unwrap();
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        let callback = format!("{}?state={}&code={code}", q["redirect_uri"], q["state"]);
        assert_eq!(reqwest::get(callback).await.unwrap().status(), 200);
    }

    fn new_client(client_id: &str) -> ClientChoice {
        ClientChoice::New {
            client_id: format!("  {client_id} "),
            client_secret: "secret-a".into(),
        }
    }

    async fn sign_in(h: &Harness, choice: ClientChoice) -> Result<AccountInfo, AccountError> {
        let start = h.service.begin_sign_in(choice).await?;
        approve(&start, "code-1").await;
        h.service.complete_sign_in(&start.flow_id).await
    }

    #[tokio::test]
    async fn sign_in_saves_account_with_secrets_only_in_keychain() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;

        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        assert_eq!(account.email, "me@example.com");
        assert_eq!(account.client_id, CLIENT_A, "client id is trimmed");
        assert_eq!(account.display_name.as_deref(), Some("Test User"));
        assert_eq!(
            h.service.list_accounts().await.unwrap(),
            vec![account.clone()]
        );
        assert_eq!(
            h.secrets.get(&account.id).unwrap(),
            Some(AccountSecrets {
                client_secret: "secret-a".into(),
                refresh_token: "refresh-1".into(),
            })
        );
        // The access token from sign-in is cached: no refresh call needed.
        assert_eq!(
            h.service.access_token(&account.id).await.unwrap(),
            "access-1"
        );
    }

    #[tokio::test]
    async fn second_account_reuses_first_accounts_client() {
        let h = harness().await;
        mock_google(&h.server, "one@example.com", "refresh-1").await;
        let first = sign_in(&h, new_client(CLIENT_A)).await.unwrap();

        mock_google(&h.server, "two@example.com", "refresh-2").await;
        let second = sign_in(
            &h,
            ClientChoice::SameAs {
                account_id: first.id.clone(),
            },
        )
        .await
        .unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(second.client_id, CLIENT_A);
        let token_calls = h.server.received_requests().await.unwrap();
        let exchange = token_calls
            .iter()
            .find(|r| r.url.path() == "/token")
            .unwrap();
        let body = String::from_utf8_lossy(&exchange.body);
        assert!(body.contains("client_secret=secret-a"), "{body}");
        assert_eq!(h.service.list_accounts().await.unwrap().len(), 2);
        assert_eq!(
            h.secrets.get(&second.id).unwrap().unwrap().refresh_token,
            "refresh-2"
        );
    }

    #[tokio::test]
    async fn signing_in_again_updates_existing_account_and_client() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let first = sign_in(&h, new_client(CLIENT_A)).await.unwrap();

        mock_google(&h.server, "me@example.com", "refresh-2").await;
        let again = sign_in(&h, new_client(CLIENT_B)).await.unwrap();

        assert_eq!(again.id, first.id);
        assert_eq!(again.client_id, CLIENT_B);
        assert_eq!(h.service.list_accounts().await.unwrap().len(), 1);
        assert_eq!(
            h.secrets.get(&first.id).unwrap().unwrap().refresh_token,
            "refresh-2"
        );
    }

    #[tokio::test]
    async fn missing_gmail_scope_or_refresh_token_saves_nothing() {
        let h = harness().await;
        for (body, code) in [
            (
                token_body(Some("r"), "https://www.googleapis.com/auth/userinfo.email"),
                "missing_scope",
            ),
            (
                token_body(None, &auth::SCOPES.join(" ")),
                "no_refresh_token",
            ),
        ] {
            h.server.reset().await;
            Mock::given(path("/token"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(&h.server)
                .await;
            let error = sign_in(&h, new_client(CLIENT_A)).await.unwrap_err();
            assert_eq!(error.code(), code);
        }
        assert!(h.service.list_accounts().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancel_stops_a_waiting_sign_in() {
        let h = harness().await;
        let start = h.service.begin_sign_in(new_client(CLIENT_A)).await.unwrap();
        let complete = h.service.complete_sign_in(&start.flow_id);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            h.service.cancel_sign_in(&start.flow_id);
        };
        let (result, ()) = tokio::join!(complete, cancel);
        assert_eq!(result.unwrap_err().code(), "cancelled");
    }

    #[tokio::test]
    async fn cancel_during_token_exchange_saves_nothing() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        h.server.reset().await;
        Mock::given(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(token_body(Some("r"), &auth::SCOPES.join(" ")))
                    .set_delay(Duration::from_millis(300)),
            )
            .mount(&h.server)
            .await;
        Mock::given(path("/userinfo"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"email": "me@example.com"})),
            )
            .mount(&h.server)
            .await;

        let start = h.service.begin_sign_in(new_client(CLIENT_A)).await.unwrap();
        approve(&start, "code-1").await;
        let complete = h.service.complete_sign_in(&start.flow_id);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            h.service.cancel_sign_in(&start.flow_id);
        };
        let (result, ()) = tokio::join!(complete, cancel);
        assert_eq!(result.unwrap_err().code(), "cancelled");
        assert!(h.service.list_accounts().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn new_sign_in_replaces_old_one() {
        let h = harness().await;
        let old = h.service.begin_sign_in(new_client(CLIENT_A)).await.unwrap();
        let _new = h.service.begin_sign_in(new_client(CLIENT_A)).await.unwrap();
        assert_eq!(
            h.service
                .complete_sign_in(&old.flow_id)
                .await
                .unwrap_err()
                .code(),
            "no_sign_in"
        );
    }

    #[tokio::test]
    async fn google_error_in_redirect_surfaces_its_code() {
        let h = harness().await;
        let start = h.service.begin_sign_in(new_client(CLIENT_A)).await.unwrap();
        let url = Url::parse(&start.auth_url).unwrap();
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        reqwest::get(format!(
            "{}?state={}&error=access_denied",
            q["redirect_uri"], q["state"]
        ))
        .await
        .unwrap();
        let error = h
            .service
            .complete_sign_in(&start.flow_id)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "access_denied");
    }

    #[tokio::test]
    async fn begin_validates_credentials_and_accounts() {
        let h = harness().await;
        for (id, secret) in [("not-a-client-id", "s"), (CLIENT_A, "  ")] {
            let error = h
                .service
                .begin_sign_in(ClientChoice::New {
                    client_id: id.into(),
                    client_secret: secret.into(),
                })
                .await
                .unwrap_err();
            assert_eq!(error.code(), "invalid_input");
        }
        let error = h
            .service
            .begin_sign_in(ClientChoice::SameAs {
                account_id: "missing".into(),
            })
            .await
            .unwrap_err();
        assert_eq!(error.code(), "not_found");
    }

    #[tokio::test]
    async fn remove_account_revokes_and_deletes_everything() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        Mock::given(method("POST"))
            .and(path("/revoke"))
            .and(body_string_contains("token=refresh-1"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&h.server)
            .await;

        h.service.remove_account(&account.id).await.unwrap();
        assert!(h.service.list_accounts().await.unwrap().is_empty());
        assert_eq!(h.secrets.get(&account.id).unwrap(), None);
        assert_eq!(
            h.service
                .remove_account(&account.id)
                .await
                .unwrap_err()
                .code(),
            "not_found"
        );
    }

    #[tokio::test]
    async fn remove_account_survives_failed_revoke() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        Mock::given(path("/revoke"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&h.server)
            .await;
        h.service.remove_account(&account.id).await.unwrap();
        assert!(h.service.list_accounts().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn refresh_rotates_tokens_and_reports_dead_sign_in() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();

        h.server.reset().await;
        Mock::given(path("/token"))
            .and(body_string_contains("refresh_token=refresh-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "access-2", "expires_in": 30, "refresh_token": "refresh-2"
            })))
            .expect(1)
            .mount(&h.server)
            .await;
        assert_eq!(
            h.service.refresh_access_token(&account.id).await.unwrap(),
            "access-2"
        );
        assert_eq!(
            h.secrets.get(&account.id).unwrap().unwrap().refresh_token,
            "refresh-2"
        );

        // 30 s lifetime is inside the expiry margin, so the next call refreshes again.
        h.server.reset().await;
        Mock::given(path("/token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error": "invalid_grant"})),
            )
            .mount(&h.server)
            .await;
        let error = h.service.access_token(&account.id).await.unwrap_err();
        assert_eq!(error.code(), "invalid_grant");
        assert!(error.to_string().contains("In production"));
    }

    #[tokio::test]
    async fn missing_keychain_entry_asks_to_sign_in_again() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        h.secrets.delete(&account.id).unwrap();
        let error = h
            .service
            .refresh_access_token(&account.id)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "no_saved_sign_in");
    }

    struct BrokenStore;
    impl SecretStore for BrokenStore {
        fn put(&self, _: &str, _: &AccountSecrets) -> Result<(), SecretsError> {
            Err(SecretsError::Unavailable(keyring::Error::NoStorageAccess(
                Box::new(std::io::Error::other("locked")),
            )))
        }
        fn get(&self, _: &str) -> Result<Option<AccountSecrets>, SecretsError> {
            Err(SecretsError::Corrupt)
        }
        fn delete(&self, _: &str) -> Result<(), SecretsError> {
            Err(SecretsError::Other("nope".into()))
        }
    }

    #[tokio::test]
    async fn keychain_failure_aborts_sign_in_without_saving() {
        let mut h = harness().await;
        h.service.secrets = Arc::new(BrokenStore);
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let error = sign_in(&h, new_client(CLIENT_A)).await.unwrap_err();
        assert_eq!(error.code(), "keychain_unavailable");
        assert!(h.service.list_accounts().await.unwrap().is_empty());
    }

    #[test]
    fn client_choice_deserializes_from_frontend_shape() {
        let new: ClientChoice = serde_json::from_value(serde_json::json!({
            "kind": "new", "clientId": "x", "clientSecret": "y"
        }))
        .unwrap();
        assert!(matches!(new, ClientChoice::New { .. }));
        let same: ClientChoice =
            serde_json::from_value(serde_json::json!({"kind": "sameAs", "accountId": "a"}))
                .unwrap();
        assert!(matches!(same, ClientChoice::SameAs { account_id } if account_id == "a"));
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(
            AccountError::Secrets(SecretsError::Corrupt).code(),
            "keychain_corrupt"
        );
        assert_eq!(
            AccountError::Secrets(SecretsError::Other("x".into())).code(),
            "keychain_error"
        );
        assert_eq!(
            AccountError::from(anyhow::anyhow!("boom")).code(),
            "internal"
        );
    }
}
