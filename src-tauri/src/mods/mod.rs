pub mod network;
mod oauth;
mod package;
mod runtime;
pub mod schema;

use crate::secrets::Keychain;
use runtime::{Event, Worker};
use schema::{ensure, validate_blocks, Block, Manifest, Views, MAX_JSON};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};
use tokio::sync::{watch, Mutex as AsyncMutex};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    manifest: Manifest,
    directory: String,
    enabled: bool,
}

struct Session {
    generation: String,
    worker: Worker,
    cancel: watch::Sender<bool>,
    views: Views,
}

#[derive(Default)]
struct State {
    records: BTreeMap<String, Record>,
    sessions: BTreeMap<String, Session>,
    staged: BTreeMap<String, Manifest>,
    errors: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModInfo {
    pub manifest: Manifest,
    pub enabled: bool,
    pub running: bool,
    pub error: Option<String>,
    pub views: Views,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub safe_mode: bool,
    pub mods: Vec<ModInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub ticket: String,
    pub manifest: Manifest,
    pub replacing: bool,
}

pub type OpenBrowser = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

pub struct ModService {
    root: PathBuf,
    state: Mutex<State>,
    operation: AsyncMutex<()>,
    keychain: Arc<dyn Keychain>,
    safe_mode: bool,
    changed: Arc<dyn Fn() + Send + Sync>,
    open_browser: OpenBrowser,
}

impl ModService {
    pub async fn open(
        root: PathBuf,
        keychain: Arc<dyn Keychain>,
        safe_mode: bool,
        changed: Arc<dyn Fn() + Send + Sync>,
        open_browser: OpenBrowser,
    ) -> Result<Arc<Self>, String> {
        fs::create_dir_all(root.join("packages")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("data")).map_err(|e| e.to_string())?;
        // Uncommitted staging is disposable and never contains preferences or credentials.
        if root.join("staging").exists() {
            fs::remove_dir_all(root.join("staging")).map_err(|e| e.to_string())?;
        }
        fs::create_dir(root.join("staging")).map_err(|e| e.to_string())?;
        let records: BTreeMap<String, Record> = if root.join("installed.json").exists() {
            serde_json::from_slice(&package::read_limited(
                &root.join("installed.json"),
                1024 * 1024,
            )?)
            .map_err(|_| "Installed mod metadata is unreadable; mail remains available")?
        } else {
            BTreeMap::new()
        };
        ensure(records.len() <= 32, "Too many installed mods")?;
        for (id, record) in &records {
            ensure(
                schema::valid_id(id)
                    && id == &record.manifest.id
                    && uuid::Uuid::parse_str(&record.directory).is_ok(),
                "Invalid installed mod metadata",
            )?;
            package::relative_path(&record.manifest.entry)?;
        }
        let service = Arc::new(Self {
            root,
            state: Mutex::new(State {
                records,
                ..State::default()
            }),
            operation: AsyncMutex::new(()),
            keychain,
            safe_mode,
            changed,
            open_browser,
        });
        if !safe_mode {
            let startup = service.clone();
            tokio::spawn(async move {
                let _operation = startup.operation.lock().await;
                let ids: Vec<_> = startup
                    .state
                    .lock()
                    .unwrap()
                    .records
                    .iter()
                    .filter(|(_, r)| r.enabled)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    if let Err(error) = startup.start(&id).await {
                        startup.fail(&id, None, &error);
                    }
                }
                (startup.changed)();
            });
        }
        Ok(service)
    }

    fn persist(&self, state: &State) -> Result<(), String> {
        package::atomic_json(&self.root.join("installed.json"), &state.records)
    }

    pub fn snapshot(&self) -> Snapshot {
        let state = self.state.lock().unwrap();
        Snapshot {
            safe_mode: self.safe_mode,
            mods: state
                .records
                .iter()
                .map(|(id, r)| {
                    let session = state
                        .sessions
                        .get(id)
                        .filter(|s| !s.worker.stopped.load(Ordering::SeqCst));
                    ModInfo {
                        manifest: r.manifest.clone(),
                        enabled: r.enabled,
                        running: session.is_some(),
                        error: state.errors.get(id).cloned(),
                        views: session.map(|s| s.views.clone()).unwrap_or_default(),
                    }
                })
                .collect(),
        }
    }

    pub fn prepare(&self, source: &Path) -> Result<Prepared, String> {
        let mut state = self.state.lock().unwrap();
        // One pending consent at a time, and at most one bounded staged package.
        let stale: Vec<_> = state.staged.keys().cloned().collect();
        for ticket in stale {
            let _ = fs::remove_dir_all(self.root.join("staging").join(&ticket));
        }
        state.staged.clear();
        let ticket = uuid::Uuid::new_v4().to_string();
        let destination = self.root.join("staging").join(&ticket);
        let manifest = match package::stage(source, &destination) {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = fs::remove_dir_all(destination);
                return Err(error);
            }
        };
        let replacing = state.records.contains_key(&manifest.id);
        if !replacing && state.records.len() >= 32 {
            let _ = fs::remove_dir_all(destination);
            return Err("You can install up to 32 mods".into());
        }
        state.staged.insert(ticket.clone(), manifest.clone());
        Ok(Prepared {
            ticket,
            manifest,
            replacing,
        })
    }

    pub fn discard(&self, ticket: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.staged.remove(ticket).is_some() {
            fs::remove_dir_all(self.root.join("staging").join(ticket))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub async fn install(self: &Arc<Self>, ticket: &str) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        let (id, previous, directory) = {
            let mut state = self.state.lock().unwrap();
            let manifest = state
                .staged
                .remove(ticket)
                .ok_or("Installation expired; select the folder again")?;
            let id = manifest.id.clone();
            let previous = state.records.get(&id).cloned();
            // A changed OAuth declaration cannot inherit credentials issued to the old provider.
            if let Some(old) = &previous {
                for connection in &old.manifest.permissions.connections {
                    if !manifest.permissions.connections.contains(connection) {
                        oauth::disconnect(self.keychain.as_ref(), &id, &connection.id)?;
                    }
                }
            }
            Self::stop_locked(&mut state, &id);
            let directory = uuid::Uuid::new_v4().to_string();
            fs::rename(
                self.root.join("staging").join(ticket),
                self.root.join("packages").join(&directory),
            )
            .map_err(|e| e.to_string())?;
            state.records.insert(
                id.clone(),
                Record {
                    manifest,
                    directory: directory.clone(),
                    enabled: !self.safe_mode,
                },
            );
            state.errors.remove(&id);
            if let Err(error) = self.persist(&state) {
                if let Some(old) = &previous {
                    state.records.insert(id.clone(), old.clone());
                } else {
                    state.records.remove(&id);
                }
                let _ = fs::remove_dir_all(self.root.join("packages").join(directory));
                return Err(error);
            }
            (id, previous, directory)
        };
        if !self.safe_mode {
            if let Err(error) = self.start(&id).await {
                {
                    let mut state = self.state.lock().unwrap();
                    Self::stop_locked(&mut state, &id);
                    if let Some(old) = &previous {
                        state.records.insert(id.clone(), old.clone());
                    } else {
                        state.records.get_mut(&id).unwrap().enabled = false;
                    }
                    state
                        .errors
                        .insert(id.clone(), format!("Mod could not start: {error}"));
                    self.persist(&state)?;
                }
                if let Some(old) = &previous {
                    let _ = fs::remove_dir_all(self.root.join("packages").join(directory));
                    if old.enabled {
                        if let Err(reason) = self.start(&id).await {
                            self.fail(&id, None, &reason);
                        }
                    }
                }
                (self.changed)();
                return Err(format!("Mod could not start: {error}. The previous package was retained where available."));
            }
        }
        if let Some(old) = previous {
            let _ = fs::remove_dir_all(self.root.join("packages").join(old.directory));
        }
        (self.changed)();
        Ok(())
    }

    fn stop_locked(state: &mut State, id: &str) {
        if let Some(session) = state.sessions.remove(id) {
            let _ = session.cancel.send(true);
            drop(session);
        }
    }

    pub async fn enable(self: &Arc<Self>, id: &str, enabled: bool) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        ensure(
            !enabled || !self.safe_mode,
            "Mods are disabled for this launch; quit and restart without --disable-mods",
        )?;
        {
            let mut state = self.state.lock().unwrap();
            let record = state.records.get_mut(id).ok_or("Mod is not installed")?;
            record.enabled = enabled;
            Self::stop_locked(&mut state, id);
            state.errors.remove(id);
            self.persist(&state)?;
        }
        if enabled {
            if let Err(error) = self.start(id).await {
                self.fail(id, None, &error);
                return Err(error);
            }
        }
        (self.changed)();
        Ok(())
    }

    pub async fn remove(&self, id: &str, keep_preferences: bool) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        let mut state = self.state.lock().unwrap();
        let record = state
            .records
            .get(id)
            .cloned()
            .ok_or("Mod is not installed")?;
        Self::stop_locked(&mut state, id);
        for connection in &record.manifest.permissions.connections {
            oauth::disconnect(self.keychain.as_ref(), id, &connection.id)?;
        }
        state.records.remove(id);
        if let Err(error) = self.persist(&state) {
            state.records.insert(id.into(), record);
            return Err(error);
        }
        state.errors.remove(id);
        let _ = fs::remove_dir_all(self.root.join("packages").join(record.directory));
        if !keep_preferences {
            let _ = fs::remove_file(self.root.join("data").join(format!("{id}.json")));
        }
        drop(state);
        (self.changed)();
        Ok(())
    }

    async fn start(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let record = self
            .state
            .lock()
            .unwrap()
            .records
            .get(id)
            .cloned()
            .ok_or("Mod is not installed")?;
        record.manifest.validate()?;
        let source = String::from_utf8(package::read_limited(
            &self
                .root
                .join("packages")
                .join(&record.directory)
                .join(&record.manifest.entry),
            package::MAX_PACKAGE,
        )?)
        .map_err(|_| "Mod entry must be UTF-8")?;
        let (events, mut receiver) = tokio::sync::mpsc::channel(64);
        let (worker, ready) = Worker::start(source, events)?;
        let generation = uuid::Uuid::new_v4().to_string();
        let (cancel, mut cancelled) = watch::channel(false);
        self.state.lock().unwrap().sessions.insert(
            id.into(),
            Session {
                generation: generation.clone(),
                worker,
                cancel,
                views: Views::default(),
            },
        );
        match tokio::time::timeout(Duration::from_secs(3), ready).await {
            Ok(Ok(true)) => {}
            _ => {
                Self::stop_locked(&mut self.state.lock().unwrap(), id);
                return Err("JavaScript failed or exceeded its execution or memory limit".into());
            }
        }
        let service = Arc::downgrade(self);
        let id = id.to_owned();
        tokio::spawn(async move {
            let mut window = std::time::Instant::now();
            let mut calls = 0;
            loop {
                let event = tokio::select! { _ = cancelled.changed() => return, event = receiver.recv() => event };
                let Some(service) = service.upgrade() else {
                    return;
                };
                if window.elapsed() >= Duration::from_secs(1) {
                    window = std::time::Instant::now();
                    calls = 0;
                }
                calls += 1;
                if calls > 120 {
                    service.fail(
                        &id,
                        Some(&generation),
                        "Mod exceeded 120 API calls per second",
                    );
                    return;
                }
                let Some(Event::Call(call)) = event else {
                    service.fail(&id, Some(&generation), "Mod stopped after an execution, memory or message limit, or a script error");
                    return;
                };
                let reply_id = call.id;
                let result = tokio::select! {
                    _ = cancelled.changed() => return,
                    result = service.handle(&id, &generation, call) => result,
                };
                if reply_id != 0 {
                    service.send(&id, &generation, json!({"type":"reply", "id":reply_id, "value":result.as_ref().ok(), "error":result.err()}));
                }
            }
        });
        Ok(())
    }

    fn fail(&self, id: &str, generation: Option<&str>, reason: &str) {
        let mut state = self.state.lock().unwrap();
        if generation.is_some_and(|g| !state.sessions.get(id).is_some_and(|s| s.generation == g)) {
            return;
        }
        Self::stop_locked(&mut state, id);
        if let Some(record) = state.records.get_mut(id) {
            record.enabled = false;
        }
        state.errors.insert(id.into(), reason.into());
        if self.persist(&state).is_err() {
            tracing::warn!("Could not persist disabled mod state");
        }
        drop(state);
        (self.changed)();
    }

    fn live<'a>(state: &'a State, id: &str, generation: &str) -> Result<&'a Session, String> {
        state
            .sessions
            .get(id)
            .filter(|s| s.generation == generation && !s.worker.stopped.load(Ordering::SeqCst))
            .ok_or("Mod session is no longer active".into())
    }

    fn send(&self, id: &str, generation: &str, message: Value) {
        let state = self.state.lock().unwrap();
        if let Ok(session) = Self::live(&state, id, generation) {
            if session.worker.sender.try_send(message).is_err() {
                session.worker.stopped.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn action(&self, id: &str, action: &str, value: Value) -> Result<(), String> {
        ensure(
            schema::valid_id(action)
                && serde_json::to_vec(&value)
                    .map_err(|_| "Invalid action value")?
                    .len()
                    <= 4000,
            "Invalid action",
        )?;
        let state = self.state.lock().unwrap();
        let session = state.sessions.get(id).ok_or("Mod is not running")?;
        Self::live(&state, id, &session.generation)?;
        let record = &state.records[id];
        let allowed = record.manifest.commands.iter().any(|c| c.id == action)
            || [
                &session.views.settings,
                &session.views.panel,
                &session.views.compact,
            ]
            .into_iter()
            .flatten()
            .any(|block| match block {
                Block::Button { id, disabled, .. } => id == action && !disabled,
                Block::Toggle { id, .. } | Block::Input { id, .. } => id == action,
                _ => false,
            });
        ensure(allowed, "Action is not contributed by this mod")?;
        session
            .worker
            .sender
            .try_send(json!({"type":"action", "id":action, "value":value}))
            .map_err(|_| "Mod is busy; try again".into())
    }

    async fn handle(
        &self,
        id: &str,
        generation: &str,
        call: runtime::Call,
    ) -> Result<Value, String> {
        {
            let state = self.state.lock().unwrap();
            Self::live(&state, id, generation)?;
        }
        match call.method.as_str() {
            "render" => {
                let surface = call.args["surface"].as_str().ok_or("Expected a surface")?;
                let blocks: Vec<Block> = serde_json::from_value(call.args["blocks"].clone())
                    .map_err(|_| "Invalid controls")?;
                validate_blocks(&blocks, surface == "compact")?;
                let mut state = self.state.lock().unwrap();
                Self::live(&state, id, generation)?;
                let views = &mut state.sessions.get_mut(id).unwrap().views;
                match surface {
                    "settings" => views.settings = blocks,
                    "panel" => views.panel = blocks,
                    "compact" => views.compact = blocks,
                    _ => return Err("Unknown mod surface".into()),
                }
                drop(state);
                (self.changed)();
                Ok(Value::Null)
            }
            "storage.get" | "storage.set" => {
                let key = call.args["key"].as_str().ok_or("Expected a storage key")?;
                ensure(schema::valid_id(key), "Invalid storage key")?;
                let state = self.state.lock().unwrap();
                Self::live(&state, id, generation)?;
                let path = self.root.join("data").join(format!("{id}.json"));
                let mut data: BTreeMap<String, Value> = if path.exists() {
                    serde_json::from_slice(&package::read_limited(&path, MAX_JSON as u64)?)
                        .map_err(|_| "Mod storage is unreadable")?
                } else {
                    BTreeMap::new()
                };
                if call.method == "storage.get" {
                    return Ok(data.get(key).cloned().unwrap_or(Value::Null));
                }
                data.insert(key.into(), call.args["value"].clone());
                ensure(
                    data.len() <= 128
                        && serde_json::to_vec(&data)
                            .map_err(|_| "Invalid storage data")?
                            .len()
                            <= MAX_JSON,
                    "Mod storage exceeds 64 KiB or 128 keys",
                )?;
                package::atomic_json(&path, &data)?;
                Ok(Value::Null)
            }
            "http" => {
                let request: network::Request =
                    serde_json::from_value(call.args).map_err(|_| "Invalid network request")?;
                let manifest = {
                    let state = self.state.lock().unwrap();
                    Self::live(&state, id, generation)?;
                    state
                        .records
                        .get(id)
                        .ok_or("Mod is not installed")?
                        .manifest
                        .clone()
                };
                let url = network::allowed(&manifest, &request)?;
                let token = if let Some(connection_id) = &request.connection {
                    let connection = manifest
                        .permissions
                        .connections
                        .iter()
                        .find(|c| &c.id == connection_id)
                        .ok_or("Unknown connection")?;
                    let tokens = oauth::read(self.keychain.as_ref(), id, connection_id)?
                        .ok_or("Connect this service in Settings first")?;
                    let tokens = if tokens.expires_at <= chrono::Utc::now().timestamp() + 30 {
                        let refreshed = oauth::refresh(connection, tokens).await?;
                        let state = self.state.lock().unwrap();
                        Self::live(&state, id, generation)?;
                        oauth::commit(self.keychain.as_ref(), id, connection_id, &refreshed)?;
                        refreshed
                    } else {
                        tokens
                    };
                    Some(tokens.access_token)
                } else {
                    None
                };
                {
                    let state = self.state.lock().unwrap();
                    Self::live(&state, id, generation)?;
                }
                serde_json::to_value(network::request(url, request, token).await?)
                    .map_err(|_| "Invalid network response".into())
            }
            "connection.status" => {
                let connection = call.args["id"].as_str().ok_or("Expected a connection ID")?;
                let state = self.state.lock().unwrap();
                Self::live(&state, id, generation)?;
                ensure(
                    state
                        .records
                        .get(id)
                        .ok_or("Mod is not installed")?
                        .manifest
                        .permissions
                        .connections
                        .iter()
                        .any(|c| c.id == connection),
                    "Unknown connection",
                )?;
                Ok(
                    json!({"connected":oauth::read(self.keychain.as_ref(), id, connection)?.is_some()}),
                )
            }
            "error" => {
                self.fail(id, Some(generation), "A mod action failed. Check its configuration, then enable the mod to try again.");
                Ok(Value::Null)
            }
            _ => Err("Unsupported mod API method".into()),
        }
    }

    pub fn connection_status(&self, id: &str, connection: &str) -> Result<bool, String> {
        let state = self.state.lock().unwrap();
        ensure(
            state.records.get(id).is_some_and(|r| {
                r.manifest
                    .permissions
                    .connections
                    .iter()
                    .any(|c| c.id == connection)
            }),
            "Unknown mod connection",
        )?;
        Ok(oauth::read(self.keychain.as_ref(), id, connection)?.is_some())
    }

    pub async fn connect(
        self: &Arc<Self>,
        id: &str,
        connection_id: &str,
        client_id: &str,
    ) -> Result<(), String> {
        let (connection, generation, mut cancelled) = {
            let state = self.state.lock().unwrap();
            let session = state
                .sessions
                .get(id)
                .ok_or("Enable the mod before connecting")?;
            Self::live(&state, id, &session.generation)?;
            let connection = state.records[id]
                .manifest
                .permissions
                .connections
                .iter()
                .find(|c| c.id == connection_id)
                .cloned()
                .ok_or("Unknown connection")?;
            (
                connection,
                session.generation.clone(),
                session.cancel.subscribe(),
            )
        };
        let tokens = tokio::select! {
            _ = cancelled.changed() => return Err("Login cancelled because the mod stopped".into()),
            result = oauth::connect(&connection, client_id, self.open_browser.clone()) => result?,
        };
        let _operation = self.operation.lock().await;
        {
            let mut state = self.state.lock().unwrap();
            Self::live(&state, id, &generation)?;
            oauth::commit(self.keychain.as_ref(), id, connection_id, &tokens)?;
            Self::stop_locked(&mut state, id);
        }
        // A fresh session cannot race an old refresh into overwriting the new login.
        if let Err(error) = self.start(id).await {
            self.fail(id, None, &error);
            return Err(error);
        }
        (self.changed)();
        Ok(())
    }

    pub async fn disconnect(self: &Arc<Self>, id: &str, connection_id: &str) -> Result<(), String> {
        // Restart the session to cancel in-flight refreshes and authenticated requests.
        let _operation = self.operation.lock().await;
        let enabled = {
            let mut state = self.state.lock().unwrap();
            let record = state.records.get(id).ok_or("Unknown mod")?;
            ensure(
                record
                    .manifest
                    .permissions
                    .connections
                    .iter()
                    .any(|c| c.id == connection_id),
                "Unknown connection",
            )?;
            let enabled = record.enabled;
            Self::stop_locked(&mut state, id);
            oauth::disconnect(self.keychain.as_ref(), id, connection_id)?;
            enabled
        };
        if enabled && !self.safe_mode {
            if let Err(error) = self.start(id).await {
                self.fail(id, None, &error);
                return Err(error);
            }
        }
        (self.changed)();
        Ok(())
    }
}

#[cfg(test)]
mod tests;
