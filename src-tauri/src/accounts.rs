//! Account sign-in, listing, removal and access tokens. Tauri-free: commands are
//! thin adapters over [`AccountService`].
//!
//! Secrets (client secret, refresh token) live only in the OS keychain. Access
//! tokens live only in memory: they expire within an hour, so persisting them
//! would add keychain writes without saving a meaningful number of refreshes.

use crate::db::accounts::{self as db_accounts, DbAccount};
use crate::gmail::auth::{self, ClientCredentials, Endpoints, Loopback, OAuthError, Pkce};
use crate::lock::lock;
use crate::secrets::{AccountSecrets, SecretStore, SecretsError};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
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
    #[error("You signed in as {actual}. To reconnect {expected}, sign in again and choose that account.")]
    WrongAccount { expected: String, actual: String },
    #[error("Something went wrong: {0}")]
    Internal(String),
}

impl AccountError {
    pub fn code(&self) -> &str {
        match self {
            Self::OAuth(error) => error.code(),
            Self::Secrets(SecretsError::Unavailable(_)) => "keychain_unavailable",
            Self::Secrets(SecretsError::Locked(_)) => "keychain_locked",
            Self::Secrets(SecretsError::Corrupt) => "keychain_corrupt",
            Self::Secrets(SecretsError::Other(_)) => "keychain_error",
            Self::Invalid(_) => "invalid_input",
            Self::NotFound => "not_found",
            Self::NoSignIn => "no_sign_in",
            Self::NoSavedSignIn => "no_saved_sign_in",
            Self::WrongAccount { .. } => "wrong_account",
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
    /// Sign an existing account in again with its own client, keeping its cached mail.
    #[serde(rename_all = "camelCase")]
    Reconnect { account_id: String },
    /// Allow calendar and tasks access for an existing account (incremental consent).
    #[serde(rename_all = "camelCase")]
    Calendar { account_id: String },
    /// Browse Drive and save new files, without access to change existing files.
    #[serde(rename_all = "camelCase")]
    Drive { account_id: String },
    /// Save a sender to Google Contacts (incremental write consent).
    #[serde(rename_all = "camelCase")]
    Contacts { account_id: String },
    /// See guests' free/busy in the event editor (incremental consent).
    #[serde(rename_all = "camelCase")]
    Availability { account_id: String },
    /// Change calendars' colours in the account's calendar list (incremental consent).
    #[serde(rename_all = "camelCase")]
    CalendarColors { account_id: String },
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
    /// The first sync has finished (Gmail's history id is known), so the cache is usable.
    pub synced: bool,
    /// 1..=12: the `--color-account-N` theme token the account is drawn in.
    pub color: i64,
}

impl From<DbAccount> for AccountInfo {
    fn from(account: DbAccount) -> Self {
        Self {
            synced: account.history_id.is_some(),
            id: account.id,
            email: account.email,
            display_name: account.display_name,
            client_id: account.client_id,
            color: account.color,
        }
    }
}

struct PendingSignIn {
    flow_id: String,
    creds: ClientCredentials,
    verifier: String,
    redirect_uri: String,
    /// Reconnecting: the address the user must sign in as.
    expected_email: Option<String>,
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
    /// One refresh at a time per account, so requests that find the token expired (or get a
    /// 401) together share one keychain read and one exchange, and a rotated refresh token
    /// is never raced by a refresh still using the old one.
    refreshing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
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
        let http = crate::http::client_builder()
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
            refreshing: Mutex::new(HashMap::new()),
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

    /// Only the native transfer service receives these; refresh tokens never leave here.
    pub async fn client_for_transfer(
        &self,
        account_id: &str,
    ) -> Result<ClientCredentials, AccountError> {
        let account = self.account(account_id).await?;
        Ok(self.saved_credentials(&account).await?.0)
    }

    /// Starts listening for Google's redirect and returns the URL to open in the browser.
    /// Starting a new sign-in abandons any earlier one.
    pub async fn begin_sign_in(&self, choice: ClientChoice) -> Result<SignInStart, AccountError> {
        let extra_scopes = match &choice {
            ClientChoice::Calendar { .. } => auth::CALENDAR_SCOPES,
            ClientChoice::Drive { .. } => auth::DRIVE_SCOPES,
            ClientChoice::Contacts { .. } => auth::CONTACT_WRITE_SCOPES,
            ClientChoice::Availability { .. } => auth::FREEBUSY_SCOPES,
            ClientChoice::CalendarColors { .. } => auth::CALENDAR_LIST_SCOPES,
            _ => &[],
        };
        let (creds, expected_email) = match choice {
            ClientChoice::New {
                client_id,
                client_secret,
            } => (validate_new_client(&client_id, &client_secret)?, None),
            ClientChoice::SameAs { account_id } => {
                let account = self.account(&account_id).await?;
                (self.saved_credentials(&account).await?.0, None)
            }
            ClientChoice::Reconnect { account_id }
            | ClientChoice::Calendar { account_id }
            | ClientChoice::Drive { account_id }
            | ClientChoice::Contacts { account_id }
            | ClientChoice::Availability { account_id }
            | ClientChoice::CalendarColors { account_id } => {
                let account = self.account(&account_id).await?;
                let creds = self.saved_credentials(&account).await?.0;
                (creds, Some(account.email))
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
            expected_email.as_deref(),
            extra_scopes,
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
            expected_email,
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
            // Revoke the grant just issued, but only if it belongs to nobody connected:
            // see `revoke_unused_grant`. The email is unknown without the userinfo call,
            // and if that fails we can't tell, so nothing is revoked.
            let email = auth::user_info(&self.http, &self.endpoints, &tokens.access_token)
                .await
                .ok()
                .map(|profile| profile.email);
            let token = tokens
                .refresh_token
                .as_deref()
                .unwrap_or(&tokens.access_token);
            self.revoke_unused_grant(&pending.creds, token, email.as_deref())
                .await;
            return Err(OAuthError::MissingScope.into());
        }
        let refresh_token = tokens
            .refresh_token
            .clone()
            .ok_or(OAuthError::NoRefreshToken)?;
        let mut profile =
            auth::user_info(&self.http, &self.endpoints, &tokens.access_token).await?;

        // A flow cancelled or replaced while talking to Google must not save anything.
        {
            let mut active = lock(&self.active);
            if !active.as_ref().is_some_and(|(id, _)| id == flow_id) {
                return Err(OAuthError::Cancelled.into());
            }
            *active = None;
        }
        // Reconnecting must not quietly add (or overwrite) a different account.
        if let Some(expected) = pending.expected_email {
            if !expected.eq_ignore_ascii_case(&profile.email) {
                self.revoke_unused_grant(&pending.creds, &refresh_token, Some(&profile.email))
                    .await;
                return Err(AccountError::WrongAccount {
                    expected,
                    actual: profile.email,
                });
            }
            // Same address, maybe in other case: save it onto the stored account.
            profile.email = expected;
        }

        let account = self
            .save_account(&profile, &pending.creds, refresh_token)
            .await?;
        self.cache_token(&account.id, tokens.access_token, tokens.expires_in);
        Ok(account.into())
    }

    /// Best-effort revoke of a token Google just issued for a sign-in that is being
    /// rejected, so a stray grant isn't left on the user's Google account. Google's revoke
    /// drops the whole user + OAuth client grant, so it is skipped when `email` is unknown
    /// or already connected with this same client: that would sign a working account out.
    async fn revoke_unused_grant(
        &self,
        creds: &ClientCredentials,
        token: &str,
        email: Option<&str>,
    ) {
        let Some(email) = email else { return };
        match db_accounts::list_accounts(&self.db).await {
            Ok(accounts) => {
                if accounts.iter().any(|account| {
                    account.client_id == creds.client_id
                        && account.email.eq_ignore_ascii_case(email)
                }) {
                    return;
                }
            }
            // Can't tell whether the grant is shared, so leave it.
            Err(_) => return,
        }
        if let Some(error) = self.revoke_within_timeout(token).await {
            tracing::warn!("couldn't revoke the rejected sign-in's token: {error}");
        }
    }

    /// Asks Google to revoke `token`, giving up after [`REVOKE_TIMEOUT`]; the error when it
    /// didn't work (callers only log it).
    async fn revoke_within_timeout(&self, token: &str) -> Option<OAuthError> {
        let revoke = auth::revoke(&self.http, &self.endpoints, token);
        match tokio::time::timeout(REVOKE_TIMEOUT, revoke).await {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some(OAuthError::Timeout),
        }
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
                        color: db_accounts::free_color(&db_accounts::used_colors(&self.db).await?),
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

    /// Draws the account in colour `color` (1..=12).
    pub async fn set_account_color(
        &self,
        account_id: &str,
        color: i64,
    ) -> Result<(), AccountError> {
        if !(1..=db_accounts::ACCOUNT_COLORS).contains(&color) {
            return Err(AccountError::Invalid(format!(
                "There is no account colour {color}."
            )));
        }
        if db_accounts::set_color(&self.db, account_id, color).await? {
            Ok(())
        } else {
            Err(AccountError::NotFound)
        }
    }

    /// Lists the accounts in `account_ids`' order from now on.
    pub async fn reorder_accounts(&self, account_ids: &[String]) -> Result<(), AccountError> {
        Ok(db_accounts::reorder(&self.db, account_ids).await?)
    }

    /// Revokes Google access (best effort), then deletes the secrets, cached mail, the
    /// account's resync position and the AI-assistant activity that mentions it (matched by
    /// its id or email in the logged arguments, summary and result: the log has no account
    /// column, so calls that named no account stay). Attachment files on disk are the mail
    /// service's ([`crate::mail::MailService::forget_account`]).
    pub async fn remove_account(&self, account_id: &str) -> Result<(), AccountError> {
        let account = self.account(account_id).await?;
        let id = account_id.to_owned();
        if let Some(secrets) = self.keychain(move |store| store.get(&id)).await? {
            if let Some(error) = self.revoke_within_timeout(&secrets.refresh_token).await {
                tracing::warn!("couldn't revoke Google access for {account_id}: {error}");
            }
        }
        let id = account_id.to_owned();
        self.keychain(move |store| store.delete(&id)).await?;
        // One transaction, so a failure partway never leaves a half-removed account.
        let mut tx = crate::db::begin_write(&self.db).await?;
        db_accounts::delete_account(&mut *tx, account_id).await?;
        crate::db::settings::delete_inbox_tabs(&mut *tx, account_id).await?;
        crate::db::settings::delete_signatures(&mut *tx, account_id).await?;
        crate::db::settings::clear_resync(&mut *tx, account_id).await?;
        crate::db::assistant::delete_activity_mentioning(&mut tx, &[account_id, &account.email])
            .await?;
        tx.commit().await.map_err(anyhow::Error::new)?;
        lock(&self.tokens).remove(account_id);
        lock(&self.refreshing).remove(account_id);
        Ok(())
    }

    fn cache_token(&self, account_id: &str, token: String, expires_in: u64) {
        let expires_at = Instant::now() + Duration::from_secs(expires_in);
        lock(&self.tokens).insert(account_id.to_owned(), (token, expires_at));
    }

    /// The cached access token, if it won't expire within the margin.
    fn cached_token(&self, account_id: &str) -> Option<String> {
        let tokens = lock(&self.tokens);
        let (token, expires_at) = tokens.get(account_id)?;
        (*expires_at > Instant::now() + EXPIRY_MARGIN).then(|| token.clone())
    }

    /// A valid access token for API calls, refreshing it when it's about to expire.
    pub async fn access_token(&self, account_id: &str) -> Result<String, AccountError> {
        if let Some(token) = self.cached_token(account_id) {
            return Ok(token);
        }
        self.refresh_after(account_id, None).await
    }

    /// Exchanges the stored refresh token for a new access token. Callers that ask while
    /// another refresh for the account runs wait for it and share its token.
    pub async fn refresh_access_token(&self, account_id: &str) -> Result<String, AccountError> {
        let stale = lock(&self.tokens)
            .get(account_id)
            .map(|(token, _)| token.clone());
        self.refresh_after(account_id, stale.as_deref()).await
    }

    async fn refresh_after(
        &self,
        account_id: &str,
        rejected: Option<&str>,
    ) -> Result<String, AccountError> {
        let gate = Arc::clone(
            lock(&self.refreshing)
                .entry(account_id.to_owned())
                .or_default(),
        );
        let _refreshing = gate.lock().await;
        // A late 401 can arrive after a different request already replaced its token.
        if let Some(token) = self
            .cached_token(account_id)
            .filter(|token| Some(token.as_str()) != rejected)
        {
            return Ok(token);
        }
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

/// Supplies one account's access tokens to a [`GmailClient`](crate::gmail::GmailClient).
pub struct AccountTokens {
    service: Arc<AccountService>,
    account_id: String,
}

impl AccountTokens {
    pub fn new(service: Arc<AccountService>, account_id: impl Into<String>) -> Self {
        Self {
            service,
            account_id: account_id.into(),
        }
    }
}

#[async_trait::async_trait]
impl crate::gmail::TokenProvider for AccountTokens {
    async fn access_token(&self) -> Result<String, crate::gmail::GmailError> {
        self.service
            .access_token(&self.account_id)
            .await
            .map_err(token_error)
    }

    async fn refresh_access_token(
        &self,
        rejected: &str,
    ) -> Result<String, crate::gmail::GmailError> {
        self.service
            .refresh_after(&self.account_id, Some(rejected))
            .await
            .map_err(token_error)
    }
}

/// A dead or missing sign-in is `SignedOut`, so the UI can offer to sign in again. Not reaching
/// Google to refresh the token is `Offline` (no Gmail request went out), not a sign-in problem,
/// and neither is a keychain that can't be read right now (`KeychainLocked`: asleep or locked).
fn token_error(error: AccountError) -> crate::gmail::GmailError {
    match error {
        AccountError::OAuth(OAuthError::InvalidGrant) | AccountError::NoSavedSignIn => {
            crate::gmail::GmailError::SignedOut(error.to_string())
        }
        AccountError::OAuth(OAuthError::Network(message)) => {
            crate::gmail::GmailError::Offline(message)
        }
        AccountError::Secrets(SecretsError::Locked(_)) => {
            crate::gmail::GmailError::KeychainLocked(error.to_string())
        }
        other => crate::gmail::GmailError::Auth(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::TestDb;
    use crate::secrets::MemoryStore;
    use reqwest::Url;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const CLIENT_A: &str = "a.apps.googleusercontent.com";
    const CLIENT_B: &str = "b.apps.googleusercontent.com";

    struct Harness {
        db: TestDb,
        service: AccountService,
        secrets: Arc<MemoryStore>,
        server: MockServer,
    }

    async fn harness() -> Harness {
        let db = TestDb::new().await;
        let server = MockServer::start().await;
        let secrets = Arc::new(MemoryStore::new());
        let endpoints = Endpoints {
            auth: format!("{}/auth", server.uri()),
            token: format!("{}/token", server.uri()),
            userinfo: format!("{}/userinfo", server.uri()),
            revoke: format!("{}/revoke", server.uri()),
        };
        let service = AccountService::with_endpoints(
            db.pool.clone(),
            secrets.clone(),
            endpoints,
            Duration::from_secs(10),
        );
        Harness {
            db,
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
        assert_eq!(
            crate::http::client()
                .get(callback)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
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
    async fn account_info_reports_synced() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        assert!(
            !account.synced,
            "a new account hasn't finished its first sync"
        );

        db_accounts::update_history_id(&h.service.db, &account.id, "42", 1)
            .await
            .unwrap();
        let listed = h.service.list_accounts().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(
            listed[0].synced,
            "a history id means the first sync is done"
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
        crate::http::client()
            .get(format!(
                "{}?state={}&error=access_denied",
                q["redirect_uri"], q["state"]
            ))
            .send()
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

    /// A signed-in account whose revoke Google will accept, ready to be removed.
    async fn removable_account() -> (Harness, AccountInfo) {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        Mock::given(path("/revoke"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&h.server)
            .await;
        (h, account)
    }

    #[tokio::test]
    async fn remove_account_forgets_inbox_tabs() {
        let (h, account) = removable_account().await;
        let pool = &h.db.pool;
        crate::db::settings::set_inbox_tabs(pool, &account.id, &["CATEGORY_SOCIAL".to_owned()])
            .await
            .unwrap();
        let key = format!("inbox_tabs.{}", account.id);
        let stored = || async {
            sqlx::query_scalar::<_, String>("SELECT value FROM app_settings WHERE key = ?")
                .bind(&key)
                .fetch_optional(pool)
                .await
                .unwrap()
        };
        assert!(stored().await.is_some());

        h.service.remove_account(&account.id).await.unwrap();
        assert_eq!(stored().await, None);
    }

    #[tokio::test]
    async fn remove_account_forgets_resync_position_and_assistant_activity() {
        let (h, account) = removable_account().await;
        let pool = &h.db.pool;
        crate::db::settings::set_resync_position(pool, &account.id, "m1")
            .await
            .unwrap();
        for arguments in [
            r#"{"account":"me@example.com","query":"secret"}"#.to_owned(),
            format!(r#"{{"account":"{}"}}"#, account.id),
            r#"{"account":"keep@example.com"}"#.to_owned(),
        ] {
            crate::db::assistant::add_activity(
                pool,
                &crate::db::assistant::NewActivity {
                    client_id: "c",
                    client_name: "Claude",
                    tool: "search_mail",
                    summary: "",
                    arguments: &arguments,
                    result: None,
                    error: None,
                    at: 1,
                },
            )
            .await
            .unwrap();
        }

        h.service.remove_account(&account.id).await.unwrap();
        assert_eq!(
            crate::db::settings::resync_position(pool, &account.id)
                .await
                .unwrap(),
            None
        );
        let left = crate::db::assistant::list_activity(pool, 10).await.unwrap();
        assert_eq!(left.len(), 1);
        assert!(left[0].arguments.contains("keep@example.com"));
    }

    #[tokio::test]
    async fn remove_account_deletes_nothing_when_one_delete_fails() {
        let (h, account) = removable_account().await;
        let pool = &h.db.pool;
        crate::db::settings::set_resync_position(pool, &account.id, "m1")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER block_activity_delete BEFORE DELETE ON assistant_activity
             BEGIN SELECT RAISE(ABORT, 'blocked'); END",
        )
        .execute(pool)
        .await
        .unwrap();
        crate::db::assistant::add_activity(
            pool,
            &crate::db::assistant::NewActivity {
                client_id: "c",
                client_name: "Claude",
                tool: "search_mail",
                summary: "",
                arguments: r#"{"account":"me@example.com"}"#,
                result: None,
                error: None,
                at: 1,
            },
        )
        .await
        .unwrap();

        assert!(h.service.remove_account(&account.id).await.is_err());
        assert!(
            h.service.list_accounts().await.unwrap().len() == 1,
            "the account row is still there"
        );
        assert_eq!(
            crate::db::settings::resync_position(pool, &account.id)
                .await
                .unwrap(),
            Some("m1".to_owned())
        );
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
        assert!(error.to_string().contains("Sign in again"));
    }

    #[tokio::test]
    async fn simultaneous_refreshes_share_one_exchange() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();

        h.server.reset().await;
        Mock::given(path("/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({
                        "access_token": "access-2", "expires_in": 3600, "refresh_token": "refresh-2"
                    }))
                    .set_delay(Duration::from_millis(200)),
            )
            .expect(1)
            .mount(&h.server)
            .await;
        // Two requests got a 401 with the same token, then a third 401 came back late.
        let (a, b) = tokio::join!(
            h.service.refresh_after(&account.id, Some("access-1")),
            h.service.refresh_after(&account.id, Some("access-1"))
        );
        assert_eq!(
            (a.unwrap(), b.unwrap()),
            ("access-2".into(), "access-2".into())
        );
        assert_eq!(
            h.service
                .refresh_after(&account.id, Some("access-1"))
                .await
                .unwrap(),
            "access-2"
        );
        h.server.verify().await;
        // And two found none cached (at launch): one exchange, with the rotated token.
        lock(&h.service.tokens).remove(&account.id);
        h.server.reset().await;
        Mock::given(path("/token"))
            .and(body_string_contains("refresh_token=refresh-2"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({
                        "access_token": "access-3", "expires_in": 3600, "refresh_token": "refresh-3"
                    }))
                    .set_delay(Duration::from_millis(200)),
            )
            .expect(1)
            .mount(&h.server)
            .await;
        let (a, b) = tokio::join!(
            h.service.access_token(&account.id),
            h.service.access_token(&account.id)
        );
        assert_eq!(
            (a.unwrap(), b.unwrap()),
            ("access-3".into(), "access-3".into())
        );
        h.server.verify().await;
        assert_eq!(
            h.secrets.get(&account.id).unwrap().unwrap().refresh_token,
            "refresh-3"
        );
    }

    #[tokio::test]
    async fn account_tokens_feed_the_gmail_client() {
        use crate::gmail::TokenProvider;
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        let tokens = AccountTokens::new(Arc::new(h.service), account.id);

        assert_eq!(tokens.access_token().await.unwrap(), "access-1");

        h.server.reset().await;
        Mock::given(path("/token"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_json(serde_json::json!({"error": "invalid_grant"})),
            )
            .mount(&h.server)
            .await;
        let error = tokens.refresh_access_token("access-1").await.unwrap_err();
        assert!(
            matches!(error, crate::gmail::GmailError::SignedOut(ref m) if m.contains("Sign in again")),
            "{error:?}"
        );
        assert_eq!(error.code(), "signed_out");
    }

    #[tokio::test]
    async fn reconnect_keeps_the_account_and_preselects_its_address() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();

        mock_google(&h.server, "Me@Example.com", "refresh-2").await;
        let start = h
            .service
            .begin_sign_in(ClientChoice::Reconnect {
                account_id: account.id.clone(),
            })
            .await
            .unwrap();
        let q: HashMap<_, _> = Url::parse(&start.auth_url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(q["login_hint"], "me@example.com");
        assert_eq!(q["client_id"], CLIENT_A);
        approve(&start, "code-2").await;
        let again = h.service.complete_sign_in(&start.flow_id).await.unwrap();

        assert_eq!(again.id, account.id);
        assert_eq!(h.service.list_accounts().await.unwrap().len(), 1);
        assert_eq!(
            h.secrets.get(&account.id).unwrap().unwrap().refresh_token,
            "refresh-2"
        );
    }

    #[tokio::test]
    async fn reconnect_as_another_address_saves_nothing() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();

        mock_google(&h.server, "other@example.com", "refresh-2").await;
        // The stranger isn't connected, so the grant just issued to them is revoked.
        Mock::given(method("POST"))
            .and(path("/revoke"))
            .and(body_string_contains("token=refresh-2"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&h.server)
            .await;
        let error = sign_in(
            &h,
            ClientChoice::Reconnect {
                account_id: account.id.clone(),
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.code(), "wrong_account");
        assert!(error.to_string().contains("me@example.com"), "{error}");
        assert_eq!(
            h.service.list_accounts().await.unwrap(),
            vec![account.clone()]
        );
        assert_eq!(
            h.secrets.get(&account.id).unwrap().unwrap().refresh_token,
            "refresh-1"
        );
    }

    #[tokio::test]
    async fn wrong_account_that_is_already_connected_keeps_its_grant() {
        let h = harness().await;
        mock_google(&h.server, "one@example.com", "refresh-1").await;
        let one = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        mock_google(&h.server, "two@example.com", "refresh-2").await;
        let _two = sign_in(
            &h,
            ClientChoice::SameAs {
                account_id: one.id.clone(),
            },
        )
        .await
        .unwrap();

        // Reconnecting `one` but signing in as `two`: revoking would sign `two` out.
        Mock::given(path("/revoke"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&h.server)
            .await;
        let error = sign_in(
            &h,
            ClientChoice::Reconnect {
                account_id: one.id.clone(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code(), "wrong_account");
        h.server.verify().await;
    }

    #[tokio::test]
    async fn missing_scope_revokes_only_a_grant_nobody_connected_uses() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();

        let thin = token_body(
            Some("thin-refresh"),
            "https://www.googleapis.com/auth/userinfo.email",
        );
        let mock_thin = |email: &'static str| {
            let thin = thin.clone();
            let server = &h.server;
            async move {
                mock_google(server, email, "unused").await;
                server.reset().await;
                Mock::given(path("/token"))
                    .respond_with(ResponseTemplate::new(200).set_body_json(thin))
                    .mount(server)
                    .await;
                Mock::given(path("/userinfo"))
                    .respond_with(
                        ResponseTemplate::new(200)
                            .set_body_json(serde_json::json!({"email": email})),
                    )
                    .mount(server)
                    .await;
            }
        };

        // Re-auth of a connected account: its grant is shared, so it is left alone.
        mock_thin("me@example.com").await;
        Mock::given(path("/revoke"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&h.server)
            .await;
        let error = sign_in(
            &h,
            ClientChoice::Reconnect {
                account_id: account.id.clone(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code(), "missing_scope");
        h.server.verify().await;

        // A new user who withheld the scope: the grant just issued is revoked.
        mock_thin("new@example.com").await;
        Mock::given(path("/revoke"))
            .and(body_string_contains("token=thin-refresh"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&h.server)
            .await;
        let error = sign_in(&h, new_client(CLIENT_A)).await.unwrap_err();
        assert_eq!(error.code(), "missing_scope");
        h.server.verify().await;
    }

    #[tokio::test]
    async fn calendar_consent_requires_the_same_account() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();

        let start = h
            .service
            .begin_sign_in(ClientChoice::Calendar {
                account_id: account.id.clone(),
            })
            .await
            .unwrap();
        let q: HashMap<_, _> = Url::parse(&start.auth_url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(q["login_hint"], "me@example.com");
        assert!(q["scope"].split(' ').any(|s| s == auth::CALENDAR_SCOPE));
        h.service.cancel_sign_in(&start.flow_id);

        mock_google(&h.server, "other@example.com", "refresh-2").await;
        let error = sign_in(
            &h,
            ClientChoice::Calendar {
                account_id: account.id.clone(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code(), "wrong_account");
        assert_eq!(
            h.secrets.get(&account.id).unwrap().unwrap().refresh_token,
            "refresh-1"
        );
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

    #[tokio::test]
    async fn optional_drive_and_contact_consent_keep_identity_and_scopes_separate() {
        let h = harness().await;
        mock_google(&h.server, "me@example.com", "refresh-1").await;
        let account = sign_in(&h, new_client(CLIENT_A)).await.unwrap();
        for (choice, expected, absent) in [
            (
                ClientChoice::Drive {
                    account_id: account.id.clone(),
                },
                auth::DRIVE_SCOPES[0],
                auth::CONTACT_WRITE_SCOPES[0],
            ),
            (
                ClientChoice::Contacts {
                    account_id: account.id.clone(),
                },
                auth::CONTACT_WRITE_SCOPES[0],
                auth::DRIVE_SCOPES[0],
            ),
            (
                ClientChoice::Availability {
                    account_id: account.id.clone(),
                },
                auth::FREEBUSY_SCOPES[0],
                // Never the broader calendar scopes: availability is its own consent.
                auth::CALENDAR_SCOPE,
            ),
            (
                ClientChoice::CalendarColors {
                    account_id: account.id.clone(),
                },
                auth::CALENDAR_LIST_SCOPES[0],
                auth::CALENDAR_SCOPE,
            ),
        ] {
            let start = h.service.begin_sign_in(choice).await.unwrap();
            let q: HashMap<_, _> = Url::parse(&start.auth_url)
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
            assert_eq!(q["login_hint"], account.email);
            assert_eq!(q["include_granted_scopes"], "true");
            assert!(q["scope"].split(' ').any(|s| s == expected));
            assert!(!q["scope"].split(' ').any(|s| s == absent));
            assert!(!q["scope"]
                .split(' ')
                .any(|s| s == "https://www.googleapis.com/auth/drive"));
            h.service.cancel_sign_in(&start.flow_id);
        }
        mock_google(&h.server, "other@example.com", "refresh-2").await;
        let error = sign_in(
            &h,
            ClientChoice::Drive {
                account_id: account.id.clone(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code(), "wrong_account");
        assert_eq!(
            h.secrets.get(&account.id).unwrap().unwrap().refresh_token,
            "refresh-1"
        );
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
        let reconnect: ClientChoice =
            serde_json::from_value(serde_json::json!({"kind": "reconnect", "accountId": "a"}))
                .unwrap();
        assert!(matches!(reconnect, ClientChoice::Reconnect { account_id } if account_id == "a"));
        let calendar: ClientChoice =
            serde_json::from_value(serde_json::json!({"kind": "calendar", "accountId": "a"}))
                .unwrap();
        assert!(matches!(calendar, ClientChoice::Calendar { account_id } if account_id == "a"));
        let availability: ClientChoice =
            serde_json::from_value(serde_json::json!({"kind": "availability", "accountId": "a"}))
                .unwrap();
        assert!(
            matches!(availability, ClientChoice::Availability { account_id } if account_id == "a")
        );
    }

    #[test]
    fn unreachable_token_refresh_is_offline_not_auth() {
        let error = token_error(AccountError::OAuth(OAuthError::Network("dns".into())));
        assert!(
            matches!(error, crate::gmail::GmailError::Offline(_)),
            "{error:?}"
        );
    }

    #[test]
    fn unreadable_keychain_is_a_wait_not_a_sign_in_problem() {
        let error = token_error(AccountError::Secrets(SecretsError::Locked(
            keyring::Error::NoEntry,
        )));
        assert!(
            matches!(error, crate::gmail::GmailError::KeychainLocked(_)),
            "{error:?}"
        );
        assert_eq!(error.code(), "keychain_locked");
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(
            AccountError::Secrets(SecretsError::Locked(keyring::Error::NoEntry)).code(),
            "keychain_locked"
        );
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
