//! The local API: what AI assistants (and any later script or CLI) may do with Pheeme, and
//! the one place its rules are enforced: the on/off switch, client tokens, and the activity
//! log. Every operation calls the same services the UI's commands do (`MailService`,
//! `FilterService`...), so a change made here goes through the outbox and sync exactly like a
//! click; this layer never reads or writes mail tables itself. The MCP server (`crate::mcp`)
//! is a thin adapter over [`LocalApi::call`]. Tauri-free.

mod read;
mod requests;
mod write;

pub use requests::{catalog, Request, ToolDef};

use crate::accounts::{AccountError, AccountService};
use crate::compose::ComposeService;
use crate::db::{assistant as db, settings};
use crate::filters::FilterService;
use crate::gmail;
use crate::labels::LabelService;
use crate::mail::{MailError, MailService};
use crate::sync::engine::now_ms;
use crate::sync::manager::SyncManager;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::sync::Arc;

/// Activity rows the Settings page shows.
pub const ACTIVITY_SHOWN: i64 = 50;
/// Longest client name kept.
const NAME_MAX: usize = 60;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("MCP is turned off. Turn on Settings › MCP › Allow MCP connections in Pheeme.")]
    Disabled,
    #[error("Pheeme doesn't recognise this token. Connect the client again from Settings › MCP.")]
    Unauthorized,
    #[error("Pheeme has no tool called {0}.")]
    UnknownTool(String),
    #[error("The user hasn't allowed MCP clients to {}. They can turn on Settings › MCP › {} in Pheeme.", .0.what(), .0.title())]
    NotAllowed(Permission),
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Mail(#[from] MailError),
    #[error(transparent)]
    Account(#[from] AccountError),
}

impl ApiError {
    pub fn code(&self) -> &str {
        match self {
            ApiError::Disabled => "disabled",
            ApiError::NotAllowed(_) => "not_allowed",
            ApiError::Unauthorized => "unauthorized",
            ApiError::UnknownTool(_) | ApiError::Invalid(_) => "invalid_input",
            ApiError::Mail(e) => e.code(),
            ApiError::Account(e) => e.code(),
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        ApiError::Mail(e.into())
    }
}

/// A group of write tools the user allows separately (all off by default). Reading needs
/// only the main switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    /// Archive, inbox, read/unread, star, labels, trash, create label.
    Organize,
    /// Create and delete Gmail filters.
    Filters,
    /// Create drafts.
    Drafts,
    /// Unsubscribe in one click.
    Unsubscribe,
}

impl Permission {
    pub const ALL: [Permission; 4] = [
        Permission::Organize,
        Permission::Filters,
        Permission::Drafts,
        Permission::Unsubscribe,
    ];

    /// The `app_settings` key part.
    pub fn key(self) -> &'static str {
        match self {
            Permission::Organize => "organize",
            Permission::Filters => "filters",
            Permission::Drafts => "drafts",
            Permission::Unsubscribe => "unsubscribe",
        }
    }

    /// The Settings switch.
    pub fn title(self) -> &'static str {
        match self {
            Permission::Organize => "Organize mail",
            Permission::Filters => "Change Gmail filters",
            Permission::Drafts => "Write drafts",
            Permission::Unsubscribe => "Unsubscribe",
        }
    }

    fn what(self) -> &'static str {
        match self {
            Permission::Organize => "archive, label, star, mark or delete mail",
            Permission::Filters => "create or delete Gmail filters",
            Permission::Drafts => "write drafts",
            Permission::Unsubscribe => "unsubscribe from mailing lists",
        }
    }
}

/// Who is calling: a connected client, found by its token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub client_id: String,
    pub client_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDto {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

impl From<db::DbClient> for ClientDto {
    fn from(c: db::DbClient) -> Self {
        Self {
            id: c.id,
            name: c.name,
            created_at: c.created_at,
            last_used_at: c.last_used_at,
        }
    }
}

/// A newly connected client and its token, shown to the user once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewClientDto {
    pub client: ClientDto,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDto {
    pub id: i64,
    pub client_name: String,
    pub tool: String,
    pub summary: String,
    /// The arguments exactly as sent (JSON).
    pub arguments: String,
    /// What came back (JSON); see [`audit_result`]. `None` when the call failed.
    pub result: Option<String>,
    pub error: Option<String>,
    pub at: i64,
}

impl From<db::DbActivity> for ActivityDto {
    fn from(a: db::DbActivity) -> Self {
        Self {
            id: a.id,
            client_name: a.client_name,
            tool: a.tool,
            summary: a.summary,
            arguments: a.arguments,
            result: a.result,
            error: a.error,
            at: a.at,
        }
    }
}

/// Called after each logged tool call, so the Settings page can refresh its log.
pub type ActivityListener = Arc<dyn Fn() + Send + Sync>;

pub struct LocalApi {
    db: SqlitePool,
    accounts: Arc<AccountService>,
    mail: MailService,
    labels: LabelService,
    compose: ComposeService,
    filters: FilterService,
    on_activity: std::sync::OnceLock<ActivityListener>,
}

impl LocalApi {
    pub fn new(
        db: SqlitePool,
        accounts: Arc<AccountService>,
        mail: MailService,
        compose: ComposeService,
        sync: Arc<SyncManager>,
    ) -> Self {
        Self {
            labels: LabelService::new(db.clone(), sync.clone()),
            filters: FilterService::new(db.clone(), sync),
            db,
            accounts,
            mail,
            compose,
            on_activity: std::sync::OnceLock::new(),
        }
    }

    /// Call `listener` after every logged tool call (the app tells the Settings page). Only the
    /// first listener set is kept.
    pub fn on_activity(&self, listener: ActivityListener) {
        let _ = self.on_activity.set(listener);
    }

    pub async fn enabled(&self) -> Result<bool, ApiError> {
        Ok(settings::assistant_enabled(&self.db).await?)
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<(), ApiError> {
        Ok(settings::set_assistant_enabled(&self.db, enabled).await?)
    }

    pub async fn allows(&self, permission: Permission) -> Result<bool, ApiError> {
        Ok(settings::assistant_allows(&self.db, permission.key()).await?)
    }

    pub async fn set_allows(&self, permission: Permission, allowed: bool) -> Result<(), ApiError> {
        Ok(settings::set_assistant_allows(&self.db, permission.key(), allowed).await?)
    }

    /// The client a bearer token belongs to.
    pub async fn authenticate(&self, token: &str) -> Result<Caller, ApiError> {
        let token = token.trim();
        if token.is_empty() {
            return Err(ApiError::Unauthorized);
        }
        let client = db::client_by_token_hash(&self.db, &hash_token(token))
            .await?
            .ok_or(ApiError::Unauthorized)?;
        Ok(Caller {
            client_id: client.id,
            client_name: client.name,
        })
    }

    /// Run one tool for `caller`, and log it. Refused while assistants are turned off.
    pub async fn call(&self, caller: &Caller, tool: &str, args: Value) -> Result<Value, ApiError> {
        if !self.enabled().await? {
            return Err(ApiError::Disabled);
        }
        let arguments = clip(args.to_string());
        let parsed = Request::parse(tool, args);
        let summary = parsed
            .as_ref()
            .map(|r| r.summary())
            .unwrap_or_else(|_| String::new());
        let result = match parsed {
            Ok(request) => match request.permission() {
                Some(p) if !self.allows(p).await? => Err(ApiError::NotAllowed(p)),
                _ => {
                    let run =
                        gmail::usage_source(gmail::UsageSource::Assistants, self.run(request));
                    gmail::user_action(run).await
                }
            },
            Err(e) => Err(e),
        };
        let error = result.as_ref().err().map(|e| e.to_string());
        let returned = result.as_ref().ok().map(|value| audit_result(tool, value));
        let at = now_ms();
        let call = db::NewActivity {
            client_id: &caller.client_id,
            client_name: &caller.client_name,
            tool,
            summary: &summary,
            arguments: &arguments,
            result: returned.as_deref(),
            error: error.as_deref(),
            at,
        };
        if let Err(e) = db::add_activity(&self.db, &call).await {
            tracing::warn!(error = %e, "couldn't log an assistant tool call");
        }
        if let Err(e) = db::touch_client(&self.db, &caller.client_id, at).await {
            tracing::warn!(error = %e, "couldn't record an assistant's last use");
        }
        if let Some(listener) = self.on_activity.get() {
            listener();
        }
        result
    }

    async fn run(&self, request: Request) -> Result<Value, ApiError> {
        match request.permission() {
            None => read::run(self, request).await,
            Some(_) => write::run(self, request).await,
        }
    }

    /// Connect a client: store its token's hash and return the token, once.
    pub async fn connect_client(&self, name: &str) -> Result<NewClientDto, ApiError> {
        let name: String = name.trim().chars().take(NAME_MAX).collect();
        if name.is_empty() {
            return Err(ApiError::Invalid("Give the assistant a name.".into()));
        }
        let token = new_token();
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = now_ms();
        db::insert_client(&self.db, &id, &name, &hash_token(&token), created_at).await?;
        Ok(NewClientDto {
            client: ClientDto {
                id,
                name,
                created_at,
                last_used_at: None,
            },
            token,
        })
    }

    pub async fn clients(&self) -> Result<Vec<ClientDto>, ApiError> {
        Ok(db::list_clients(&self.db)
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// Revoke a client's token. One already removed is fine.
    pub async fn remove_client(&self, id: &str) -> Result<(), ApiError> {
        db::delete_client(&self.db, id).await?;
        Ok(())
    }

    pub async fn activity(&self, limit: i64) -> Result<Vec<ActivityDto>, ApiError> {
        Ok(
            db::list_activity(&self.db, limit.clamp(1, db::ACTIVITY_KEEP))
                .await?
                .into_iter()
                .map(Into::into)
                .collect(),
        )
    }

    pub async fn clear_activity(&self) -> Result<(), ApiError> {
        Ok(db::clear_activity(&self.db).await?)
    }
}

/// Longest arguments or result kept in the activity log.
const AUDIT_MAX: usize = 32 * 1024;

fn clip(mut text: String) -> String {
    if text.len() > AUDIT_MAX {
        let mut end = AUDIT_MAX;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("…(cut)");
    }
    text
}

/// What the activity log keeps of a tool's answer. A change keeps it whole (it says what
/// changed). A read keeps the ids of the conversations, messages and filters it returned,
/// so the log shows what the client saw without copying the mail into it.
fn audit_result(tool: &str, value: &Value) -> String {
    let read_only = catalog()
        .iter()
        .find(|t| t.name == tool)
        .is_none_or(|t| t.read_only);
    if !read_only {
        return clip(value.to_string());
    }
    let mut seen = serde_json::Map::new();
    for key in ["thread_id", "message_id", "id", "sender"] {
        let mut ids = Vec::new();
        collect(value, key, &mut ids);
        if !ids.is_empty() {
            seen.insert(format!("{key}s"), ids.into());
        }
    }
    clip(Value::Object(seen).to_string())
}

/// Every string value under `key`, anywhere in `value`, once each.
fn collect(value: &Value, key: &str, out: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if k == key && v.is_string() && !out.contains(v) {
                    out.push(v.clone());
                } else {
                    collect(v, key, out);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect(v, key, out)),
        _ => {}
    }
}

/// `pheeme_` and 32 random bytes, base64url.
fn new_token() -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let bytes: [u8; 32] = rand::random();
    format!("pheeme_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
pub(crate) mod tests;
