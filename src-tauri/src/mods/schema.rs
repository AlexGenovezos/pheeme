use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const API_VERSION: u32 = 1;
pub const MAX_JSON: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub entry: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub commands: Vec<Command>,
    #[serde(default)]
    pub permissions: Permissions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub id: String,
    pub title: String,
    pub shortcut: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permissions {
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub connections: Vec<Connection>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub authorization_url: String,
    pub token_url: String,
    pub scopes: Vec<String>,
    pub api_origins: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Block {
    Text {
        text: String,
    },
    Button {
        id: String,
        label: String,
        #[serde(default)]
        disabled: bool,
    },
    Toggle {
        id: String,
        label: String,
        value: bool,
    },
    Input {
        id: String,
        label: String,
        value: String,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Views {
    pub settings: Vec<Block>,
    pub panel: Vec<Block>,
    pub compact: Vec<Block>,
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-' | b'_')
        })
        && value.as_bytes()[0].is_ascii_alphanumeric()
}

pub fn ensure(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

pub fn https_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid HTTPS URL")?;
    ensure(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none(),
        "Expected an HTTPS URL without credentials or a fragment",
    )?;
    Ok(url)
}

pub fn origin(value: &str) -> Result<String, String> {
    let url = https_url(value)?;
    ensure(
        url.path() == "/" && url.query().is_none(),
        "Network permissions must be exact HTTPS origins",
    )?;
    Ok(url.origin().ascii_serialization())
}

impl Manifest {
    pub fn validate(&self) -> Result<(), String> {
        ensure(valid_id(&self.id), "Mod ID must use lowercase letters, numbers, dots, underscores or hyphens (up to 64 characters)")?;
        ensure(
            !self.name.trim().is_empty()
                && self.name.len() <= 100
                && self.description.len() <= 1000,
            "Invalid mod name or description",
        )?;
        ensure(
            !self.version.is_empty() && self.version.len() <= 40,
            "Invalid mod version",
        )?;
        ensure(
            self.api_version == API_VERSION,
            "This mod needs an unsupported API version; Pheeme supports API 1",
        )?;
        ensure(
            self.entry.ends_with(".js"),
            "Mod entry must be a bundled JavaScript file",
        )?;
        ensure(
            self.commands.len() <= 32
                && self.permissions.network.len() <= 16
                && self.permissions.connections.len() <= 8,
            "Too many contributions or permissions",
        )?;
        let mut ids = BTreeSet::new();
        for command in &self.commands {
            ensure(
                valid_id(&command.id)
                    && ids.insert(&command.id)
                    && !command.title.trim().is_empty()
                    && command.title.len() <= 100,
                "Invalid or duplicate command",
            )?;
            if let Some(shortcut) = &command.shortcut {
                ensure(
                    shortcut.len() <= 50 && !shortcut.trim().is_empty(),
                    "Invalid shortcut",
                )?;
            }
        }
        for host in &self.permissions.network {
            origin(host)?;
        }
        ids.clear();
        for connection in &self.permissions.connections {
            ensure(
                valid_id(&connection.id)
                    && ids.insert(&connection.id)
                    && !connection.name.trim().is_empty()
                    && connection.name.len() <= 100,
                "Invalid or duplicate connection",
            )?;
            ensure(
                https_url(&connection.authorization_url)?.query().is_none(),
                "Authorization endpoints must not contain query parameters",
            )?;
            https_url(&connection.token_url)?;
            ensure(
                !connection.api_origins.is_empty()
                    && connection.api_origins.len() <= 8
                    && connection.scopes.len() <= 32,
                "Invalid connection origins or scopes",
            )?;
            for host in &connection.api_origins {
                origin(host)?;
            }
            for scope in &connection.scopes {
                ensure(
                    !scope.is_empty()
                        && scope.len() <= 200
                        && !scope.chars().any(char::is_whitespace),
                    "Invalid OAuth scope",
                )?;
            }
        }
        Ok(())
    }
}

pub fn validate_blocks(blocks: &[Block], compact: bool) -> Result<(), String> {
    ensure(
        blocks.len() <= if compact { 4 } else { 32 },
        "Too many controls",
    )?;
    let mut ids = BTreeSet::new();
    for block in blocks {
        match block {
            Block::Text { text } => ensure(text.len() <= 2000, "Text is too long")?,
            Block::Button { id, label, .. }
            | Block::Toggle { id, label, .. }
            | Block::Input { id, label, .. } => {
                ensure(
                    valid_id(id)
                        && ids.insert(id)
                        && !label.trim().is_empty()
                        && label.len() <= 100,
                    "Invalid or duplicate control",
                )?;
            }
        }
        if let Block::Input { value, .. } = block {
            ensure(value.len() <= 2000, "Input is too long")?;
        }
    }
    Ok(())
}
