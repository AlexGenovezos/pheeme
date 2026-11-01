# Project Plan: Cross-Platform Gmail Client (Rust + Tauri)
**For use with Claude Code CLI**

> **Note (2026-10-31):** product name is **Pheeme**. Scope, priorities and phase order are now set by [`docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md`](docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md), which overrides this plan where they disagree (search is local-first, multi-account adds a combined inbox, CI lands early, Calendar follows v1). This document remains the detailed technical reference.

---

## Project Overview

Build a cross-platform, open source desktop Gmail client. The app uses the Gmail REST API (not IMAP) for a fast, Gmail-native experience. Users supply their own Google Cloud OAuth credentials on first launch (BYOC model), which eliminates centralized API verification costs and keeps the project free to distribute.

Target platforms: macOS, Windows, Linux  
Stack: Rust (backend/business logic) + Tauri v2 + React + TypeScript (frontend UI)  
License: MIT (open source)

### On the BYOC tradeoff (accepted)

BYOC is the chosen model. It is a deliberate tradeoff, not an oversight. The rationale:

- **No centralized verification burden.** Gmail scopes such as `gmail.modify`, `gmail.compose`, and `mail.google.com` are Google "restricted" OAuth scopes. A centralized OAuth client for a public app would require formal verification and may require security assessment. BYOC avoids that centralized burden because each user owns their own Google Cloud project and OAuth client.
- **No cost floor.** No hosted auth proxy, no shared client secret to rotate, no quota we have to pay for. Users consume their own per-project quota.
- **No data-trust story to sell.** Each user's Gmail flows only between their own OAuth client and their own machine. There is no intermediary we could compromise or be compelled to hand over.
- **Unverified-app warning is accepted, not ignored.** Personal-use apps with fewer than 100 users can remain unverified, but users will see Google's unverified-app warning and must click through it. The setup guide must explain this plainly.
- **Do not leave the user's OAuth app in Testing.** External OAuth apps in Testing receive refresh tokens that expire after 7 days unless they request only basic profile/email/openid scopes. Because Gmail scopes are required, the BYOC guide must tell users to publish their own OAuth app to "In production" for durable refresh tokens.

**The cost we accept:** non-technical users will not complete the Google Cloud setup. The target audience is developers and technically-inclined users. This means Phase 3 onboarding and the README's BYOC setup guide are first-class deliverables — clear screenshots, copy-paste values, and an honest explanation of each step. Treat the setup guide as product, not documentation.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│                  Tauri Shell                │
│  ┌─────────────────┐  ┌──────────────────┐  │
│  │  React + TS UI  │  │   Rust Backend   │  │
│  │  (Tauri webview)│◄─►│  (Tauri commands)│  │
│  └─────────────────┘  └────────┬─────────┘  │
│                                │             │
│                        ┌───────▼──────┐      │
│                        │  SQLite DB   │      │
│                        │ (local cache)│      │
│                        └───────┬──────┘      │
└────────────────────────────────┼─────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │      Gmail REST API      │
                    │  (Google Cloud / OAuth2) │
                    └─────────────────────────┘
```

### Key design decisions
- All Gmail API calls happen in Rust (never from the frontend directly)
- OAuth tokens stored encrypted in OS keychain via `keyring` crate
- Local message cache in SQLite via `rusqlite` or `sqlx`
- Frontend communicates with backend exclusively via Tauri commands/events
- Each user provides their own Google Cloud OAuth client ID + secret (BYOC)

---

## Repository Structure

```
gmail-client/
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── main.rs             # Tauri app entry point
│   │   ├── lib.rs              # Library root
│   │   ├── commands/           # Tauri command handlers (IPC bridge)
│   │   │   ├── mod.rs
│   │   │   ├── auth.rs         # OAuth setup, token management
│   │   │   ├── messages.rs     # Fetch/send/archive messages
│   │   │   ├── labels.rs       # Label CRUD
│   │   │   ├── threads.rs      # Thread operations
│   │   │   ├── search.rs       # Gmail search
│   │   │   ├── accounts.rs     # Multi-account management
│   │   │   └── settings.rs     # App settings
│   │   ├── gmail/              # Gmail API client layer
│   │   │   ├── mod.rs
│   │   │   ├── client.rs       # HTTP client, rate limiting, retry logic
│   │   │   ├── auth.rs         # OAuth2 PKCE flow
│   │   │   ├── messages.rs     # Messages API methods
│   │   │   ├── threads.rs      # Threads API methods
│   │   │   ├── labels.rs       # Labels API methods
│   │   │   ├── drafts.rs       # Drafts API methods
│   │   │   └── types.rs        # Gmail API response types/structs
│   │   ├── db/                 # SQLite cache layer
│   │   │   ├── mod.rs
│   │   │   ├── migrations/     # SQL migration files
│   │   │   ├── messages.rs     # Message cache queries
│   │   │   ├── threads.rs      # Thread cache queries
│   │   │   └── labels.rs       # Label cache queries
│   │   ├── sync/               # Background sync engine
│   │   │   ├── mod.rs
│   │   │   ├── engine.rs       # Sync orchestrator
│   │   │   └── history.rs      # Gmail history API for incremental sync
│   │   └── crypto.rs           # Token encryption helpers
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # React + TypeScript frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppShell.tsx        # Root 3-pane layout
│   │   │   ├── Sidebar.tsx         # Account list + labels
│   │   │   └── Resizable.tsx       # Draggable pane dividers
│   │   ├── sidebar/
│   │   │   ├── AccountSection.tsx
│   │   │   ├── LabelList.tsx
│   │   │   └── LabelItem.tsx
│   │   ├── message-list/
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageListItem.tsx
│   │   │   ├── MessageListToolbar.tsx
│   │   │   └── InboxCategoryTabs.tsx   # Primary / Social / Promotions / etc. tabs
│   │   ├── message-view/
│   │   │   ├── MessageView.tsx
│   │   │   ├── MessageHeader.tsx
│   │   │   ├── MessageBody.tsx     # Sandboxed HTML email renderer
│   │   │   └── AttachmentList.tsx
│   │   ├── compose/
│   │   │   ├── ComposeWindow.tsx
│   │   │   ├── AddressField.tsx
│   │   │   ├── RichTextEditor.tsx
│   │   │   └── AttachmentBar.tsx
│   │   ├── onboarding/
│   │   │   ├── OnboardingFlow.tsx
│   │   │   ├── CredentialSetup.tsx  # Walk user through BYOC setup
│   │   │   └── OAuthConsent.tsx
│   │   └── shared/
│   │       ├── Avatar.tsx
│   │       ├── Badge.tsx
│   │       └── Spinner.tsx
│   ├── hooks/
│   │   ├── useMessages.ts
│   │   ├── useLabels.ts
│   │   ├── useAccounts.ts
│   │   └── useSync.ts
│   ├── store/                  # Zustand state management
│   │   ├── index.ts
│   │   ├── mailStore.ts
│   │   ├── accountStore.ts
│   │   └── uiStore.ts
│   ├── lib/
│   │   ├── tauri.ts            # Typed wrappers around invoke()
│   │   └── utils.ts
│   └── styles/
│       └── global.css
├── package.json
├── vite.config.ts
├── tsconfig.json
└── README.md
```

---

## Phase 1: Project Scaffolding & Tooling

**Goal:** Working skeleton app that compiles and opens a window on all 3 platforms.

### Tasks

1. Initialize Tauri v2 project
   - Run: `npm create tauri-app@latest`
   - Choose: React + TypeScript frontend template
   - Verify build targets for macOS, Windows, Linux in `tauri.conf.json`

2. Configure Rust dependencies in `Cargo.toml`
   ```toml
   [dependencies]
   tauri = { version = "2", features = ["tray-icon", "protocol-asset"] }
   serde = { version = "1", features = ["derive"] }
   serde_json = "1"
   tokio = { version = "1", features = ["full"] }
   reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
   sqlx = { version = "0.8", features = ["sqlite", "runtime-tokio", "migrate"] }
   keyring = "3"
   base64 = "0.22"
   chrono = { version = "0.4", features = ["serde"] }
   anyhow = "1"
   thiserror = "1"
   tracing = "0.1"
   tracing-subscriber = "0.3"
   oauth2 = "5"
   open = "5"
   uuid = { version = "1", features = ["v4"] }
   ```

3. Configure frontend dependencies in `package.json`
   ```json
   {
     "dependencies": {
       "react": "^18",
       "react-dom": "^18",
       "zustand": "^4",
       "@tauri-apps/api": "^2",
       "@tauri-apps/plugin-shell": "^2",
       "@tauri-apps/plugin-notification": "^2",
       "dompurify": "^3",
       "date-fns": "^3",
       "lucide-react": "latest"
     }
   }
   ```

4. Set up Vite config with Tauri integration
5. Establish `tracing` logging in Rust with log levels for debug/release
6. Create a basic window config in `tauri.conf.json`:
   - Min window size: 900x600
   - Default size: 1280x800
   - Title: "Gmail Client"
   - Decorations: true

**Deliverable:** `cargo tauri dev` opens a blank window with React rendering "Hello World".

---

## Phase 2: Database & Migrations

**Goal:** SQLite schema in place for offline-capable message caching.

### Schema

```sql
-- migrations/001_initial.sql

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  profile_photo_url TEXT,
  client_id TEXT NOT NULL,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expiry INTEGER,
  history_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE labels (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'system' | 'user'
  message_list_visibility TEXT,
  label_list_visibility TEXT,
  color_background TEXT,
  color_text TEXT,
  messages_total INTEGER DEFAULT 0,
  messages_unread INTEGER DEFAULT 0,
  PRIMARY KEY (id, account_id)
);

CREATE TABLE threads (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject TEXT,
  snippet TEXT,
  history_id TEXT,
  label_ids TEXT,               -- JSON array
  last_message_date INTEGER,
  message_count INTEGER DEFAULT 0,
  unread_count INTEGER DEFAULT 0,
  has_attachment INTEGER DEFAULT 0,
  PRIMARY KEY (id, account_id)
);

CREATE TABLE messages (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  label_ids TEXT,               -- JSON array
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT,            -- JSON array
  cc_addresses TEXT,            -- JSON array
  subject TEXT,
  snippet TEXT,
  body_html TEXT,
  body_text TEXT,
  date INTEGER,
  size_estimate INTEGER,
  has_attachment INTEGER DEFAULT 0,
  is_read INTEGER DEFAULT 1,
  is_starred INTEGER DEFAULT 0,
  raw_headers TEXT,             -- JSON
  fully_fetched INTEGER DEFAULT 0,
  PRIMARY KEY (id, account_id)
);

CREATE TABLE attachments (
  id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  attachment_id TEXT,
  PRIMARY KEY (id, message_id, account_id)
);

CREATE INDEX idx_threads_account_label ON threads(account_id, label_ids);
CREATE INDEX idx_threads_date ON threads(last_message_date DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, account_id);
CREATE INDEX idx_messages_date ON messages(date DESC);
```

### Tasks
1. Create `db/` module with `sqlx` pool initialization
2. Write migration runner that applies all files in `db/migrations/` on startup
3. Create typed query functions for each table (insert, update, select, delete)
4. Test migrations run clean on a fresh database

**Deliverable:** App creates `~/.config/gmail-client/db.sqlite` on startup with correct schema.

---

## Phase 3: OAuth2 / First-Run Onboarding

**Goal:** User can enter their Google Cloud credentials, authorize the app, and be stored in the accounts table.

### OAuth Flow (PKCE — Desktop App)

```
User pastes Client ID + Secret
        │
        ▼
App generates PKCE code_verifier + code_challenge
        │
        ▼
App opens browser to Google OAuth URL with:
  - client_id
  - redirect_uri = http://localhost:{random_port}/oauth/callback
  - scope = phase-appropriate Gmail scopes (see below; do not request `https://mail.google.com/` unless permanent delete is implemented)
  - code_challenge + code_challenge_method=S256
  - response_type=code
        │
        ▼
Rust spins up temporary local HTTP server on same port
        │
        ▼
Google redirects to localhost with ?code=...
        │
        ▼
Rust exchanges code for access_token + refresh_token
        │
        ▼
Tokens stored encrypted in OS keychain via `keyring` crate
Account row created in SQLite
        │
        ▼
App proceeds to main inbox
```

### Required OAuth Scopes

Use the narrowest scope set that supports the enabled features. Do not request `https://mail.google.com/` for v1; Google documents it as full mailbox access including immediate permanent deletion, and recommends narrower scopes for all other actions.

**MVP / read + organize mail:**
```
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

**Add when compose/drafts are implemented:**
```
https://www.googleapis.com/auth/gmail.compose
```

**Add only when account settings features require it:**
```
https://www.googleapis.com/auth/gmail.settings.basic
```

**Avoid unless a future feature truly needs permanent delete bypassing Trash:**
```
https://mail.google.com/
```

### Tauri Commands to Implement
```rust
// src-tauri/src/commands/auth.rs

#[tauri::command]
async fn begin_oauth(client_id: String, client_secret: String) -> Result<String, String>
// Returns: auth URL to open in browser

#[tauri::command]  
async fn check_oauth_complete() -> Result<AccountInfo, String>
// Polls for completion after browser redirect

#[tauri::command]
async fn refresh_token(account_id: String) -> Result<(), String>

#[tauri::command]
async fn remove_account(account_id: String) -> Result<(), String>

#[tauri::command]
async fn list_accounts() -> Result<Vec<AccountInfo>, String>
```

### Onboarding UI Steps
1. Welcome screen — brief explanation of BYOC model with link to setup guide
2. Step-by-step Google Cloud Console instructions (with screenshots in README)
3. Form: paste Client ID + Client Secret
4. "Authorize" button — opens browser
5. Unverified-app warning screen: explain in-app what the user is about to see ("Google will show a warning because this is your own private OAuth client — click 'Advanced' → 'Go to {project} (unsafe)'. This is expected for personal-use BYOC apps that have not gone through Google's verification process.")
6. Success/waiting screen while listening for redirect
7. Confirmation with account email shown

### BYOC Setup Guide (README content — first-class deliverable)

The README must walk the user through creating a Google Cloud project end to end. At minimum:

1. Create a new Google Cloud project (name doesn't matter; suggest `gmail-client-personal`).
2. Enable the Gmail API in that project (APIs & Services → Library → Gmail API → Enable).
3. Configure OAuth consent screen: user type = External, app name = anything, support email = self, scopes = skip if Google allows it during setup (the app requests scopes at runtime).
4. Publish the OAuth app to **In production** before relying on it day to day. Do not leave it in Testing: for External apps in Testing, Google issues refresh tokens that expire after 7 days when Gmail scopes are requested.
5. Create OAuth client credentials: type = Desktop app, download the JSON, copy client ID + client secret into the app.
6. Expect the "Google hasn't verified this app" warning on first authorization — click Advanced → Go to (unsafe). You are authorizing your own app for your own account.

Screenshots for each step. Keep the guide current — Google changes the console UI yearly.

### Token Security
- Never store raw tokens in SQLite
- Use `keyring` crate to store in OS credential store:
  - macOS: Keychain
  - Windows: Windows Credential Manager
  - Linux: libsecret / kwallet
- SQLite stores only the keychain lookup key per account

**Deliverable:** User can complete OAuth flow, account appears in database, app shows inbox (empty).

---

## Phase 4: Gmail API Client Layer

**Goal:** Typed Rust wrapper around Gmail REST API with rate limiting and retry logic.

### Dependencies to add (Cargo.toml)
```toml
mailparse = "0.15"        # MIME decoding
```

### HTTP Client Setup (`gmail/client.rs`)
- Base `reqwest::Client` with connection pooling
- Automatic `Authorization: Bearer {token}` header injection
- Retry logic: exponential backoff on 429 (rate limit) and 5xx errors
  - Max 5 retries
  - Base delay: 1 second, multiplier: 2x, max delay: 32 seconds
- Auto token refresh on 401 responses
- Request timeout: 30 seconds

### API Methods to Implement

```rust
// gmail/messages.rs
pub async fn list_messages(label_ids: &[&str], page_token: Option<&str>, max_results: u32) -> Result<MessageListResponse>
pub async fn get_message(id: &str, format: MessageFormat) -> Result<Message>
pub async fn batch_get_messages(ids: &[&str]) -> Result<Vec<Message>>  // client-side parallelism via semaphore (see note below)
pub async fn modify_message(id: &str, add_labels: &[&str], remove_labels: &[&str]) -> Result<Message>
pub async fn trash_message(id: &str) -> Result<Message>
pub async fn delete_message(id: &str) -> Result<()>
pub async fn send_message(raw: &str) -> Result<Message>
pub async fn create_draft(raw: &str) -> Result<Draft>
pub async fn update_draft(id: &str, raw: &str) -> Result<Draft>
pub async fn send_draft(id: &str) -> Result<Message>

// gmail/threads.rs
pub async fn list_threads(label_ids: &[&str], page_token: Option<&str>) -> Result<ThreadListResponse>
pub async fn get_thread(id: &str) -> Result<Thread>
pub async fn modify_thread(id: &str, add_labels: &[&str], remove_labels: &[&str]) -> Result<Thread>
pub async fn trash_thread(id: &str) -> Result<Thread>

// gmail/labels.rs
pub async fn list_labels() -> Result<Vec<Label>>
pub async fn create_label(name: &str, color: Option<LabelColor>) -> Result<Label>
pub async fn update_label(id: &str, updates: LabelUpdate) -> Result<Label>
pub async fn delete_label(id: &str) -> Result<()>

// gmail/history.rs
pub async fn list_history(start_history_id: &str, label_id: Option<&str>) -> Result<HistoryListResponse>

// gmail/user.rs
pub async fn get_profile() -> Result<UserProfile>
pub async fn get_vacation_settings() -> Result<VacationSettings>
pub async fn update_vacation_settings(settings: VacationSettings) -> Result<VacationSettings>
```

### Batching strategy

Gmail offers a `batch` endpoint that accepts `multipart/mixed` with embedded HTTP requests. It is powerful but painful to implement correctly in `reqwest` (manual MIME framing, per-part response parsing, partial-failure handling). For our usage, **client-side parallelism with a `tokio::sync::Semaphore` is simpler and fast enough**:

- Semaphore permits ≈ 10 concurrent requests per account (tune with real quota observation).
- `futures::stream::iter(ids).map(fetch).buffer_unordered(N)` for ergonomic parallel fetch.
- Same retry/backoff wrapper per request.
- Partial failures handled naturally (per-future `Result`), no batch-response parser needed.

Revisit the multipart batch endpoint only if initial-sync throughput becomes a real bottleneck.

### Email MIME Parsing
- Use `mailparse` crate to decode raw RFC 2822 messages
- Extract: headers, plain text body, HTML body, attachments
- Handle multipart/alternative, multipart/mixed, multipart/related
- Decode base64url-encoded Gmail message parts
- Strip tracking pixels (block external images by default, user can override)

**Deliverable:** Rust tests that call Gmail API and return typed structs for messages, threads, labels.

---

## Phase 5: Background Sync Engine

**Goal:** Inbox stays up to date automatically without full re-fetch on every open.

> **Complexity note:** this phase is rated "High" and that is not a formality. The interaction of history expiry, initial-sync scale, and optimistic-UI races makes sync the single hardest piece of this project. Budget accordingly and write tests early.

### Sync Strategy

**Initial load (new account or first sync):**
1. Fetch all labels → store in SQLite.
2. Fetch threads for INBOX (first page, `maxResults=100`) → store metadata.
3. Fetch full message details for those threads using the Phase 4 parallel batch helper.
4. Record the `historyId` from the most recent full-message response (not the thread list — history IDs on list responses can lag).
5. Emit `sync:completed` so the UI can render.
6. Continue fetching additional pages in the background (paginate `pageToken`) until the user's retention window is covered or the user stops scrolling. Large mailboxes should not block first paint.

**Incremental sync (subsequent syncs):**
1. Call `history.list` with stored `historyId`, paginating until `nextPageToken` is absent.
2. Process history records in order:
   - `messagesAdded` → fetch and cache new messages
   - `messagesDeleted` → remove from SQLite
   - `labelsAdded` / `labelsRemoved` → update label arrays on messages/threads
3. Update stored `historyId` to the `historyId` returned at the top level of the response, not the last record's id.

**History expiry fallback (critical):** Gmail only retains history records for ~7 days. If `history.list` returns HTTP 404 with `failedPrecondition` / `"Invalid startHistoryId"`, the stored id is too old. The sync engine **must**:
1. Catch this specific error.
2. Run a full re-sync (same as initial load, but reconcile against existing cache rather than clearing it).
3. Overwrite `historyId` with the fresh value.

Users who leave the app closed for a week will hit this. Treat it as a normal codepath, not an edge case.

**Optimistic UI and race handling:** every user action (archive, label, star, delete) applies to the local cache immediately and fires the Gmail API call in the background. The sync engine must tolerate the case where:
- An incremental sync fires while an optimistic action is in flight (the history record may arrive before the API response, or the API response may contradict the optimistic state).
- Multiple actions are queued on the same thread before any sync completes.

Approach: tag each local mutation with a `pending_op_id`. When `history.list` returns a record that matches a pending op, drop it (don't re-apply). On API failure, revert the optimistic change and surface a toast. This is worth prototyping on day one of Phase 5 — retrofitting it later is painful.

**Quota awareness:** Gmail quota is 1B quota units/day per project and 250 units/user/second. `messages.get` is 5 units, `history.list` is 2 units, `messages.list` is 5 units. Parallel fetch of 500 messages during initial sync = 2,500 units, which is well under per-second cap if semaphore size ≤ 10. Log quota-like errors (429s) with full context — they indicate tuning is needed.

**Sync triggers:**
- App focus regained (window comes to foreground)
- Every 90 seconds while app is open (background timer)
- Manually via refresh button
- After any send/archive/label action (optimistic update + sync confirmation)

### Tauri Events (Backend → Frontend)
```rust
// Emitted during sync to update UI reactively
app.emit("sync:started", account_id)
app.emit("sync:messages_updated", MessageUpdatePayload { added, removed, modified })
app.emit("sync:labels_updated", Vec<Label>)
app.emit("sync:completed", account_id)
app.emit("sync:error", SyncError { account_id, message })
```

### Sync Module Structure
```rust
// sync/engine.rs
pub struct SyncEngine {
  db: Arc<SqlitePool>,
  gmail_client: Arc<GmailClient>,
  account_id: String,
}

impl SyncEngine {
  pub async fn run_initial_sync(&self) -> Result<()>
  pub async fn run_incremental_sync(&self) -> Result<()>
  pub async fn sync_label(&self, label_id: &str) -> Result<()>
}
```

**Deliverable:** Opening the app shows real inbox messages; background sync keeps them fresh.

---

## Phase 6: Core UI — 3-Pane Layout

**Goal:** Functional 3-pane email interface with working navigation.

### Layout Specification

```
┌──────────┬────────────────────┬────────────────────────────┐
│          │ [search bar      ] │  Message Header            │
│ INBOX    │────────────────────│  From: Name <email>        │
│ Starred  │ ● From Name   2h  │  To: you                   │
│ Sent     │   Subject line     │  Date: ...                 │
│ Drafts   │   Preview text...  │────────────────────────────│
│ Spam     │────────────────────│                            │
│ Trash    │ From Name     1d  │   Email body rendered      │
│──────────│   Subject line     │   as sanitized HTML        │
│ Labels   │   Preview text...  │                            │
│  ▸ Work  │                    │                            │
│  ▸ Bills │                    │                            │
│──────────│                    │────────────────────────────│
│ + Account│                    │  [Reply] [Fwd] [Archive]   │
└──────────┴────────────────────┴────────────────────────────┘
```

### Pane Sizing
- Sidebar: fixed 220px (collapsible)
- Message list: resizable, min 280px
- Message view: fills remaining space, min 400px
- Pane dividers are draggable; widths persisted to localStorage

### Sidebar Contents
- System labels: Inbox (with unread badge), Starred, Important, Sent, Drafts, Spam, Trash, All Mail
- User labels: listed below system labels, color dot if color is set
- Multi-account: each account gets its own collapsible section
- "Add Account" button at bottom
- Keyboard shortcut: `G I` go to inbox, `G S` go to starred, etc.

### Inbox Category Tabs

When the user has inbox categories enabled, a tab bar renders above the message list whenever the Inbox label is selected. This is one of the defining features of the app — it replicates the Primary / Social / Promotions experience from Gmail's web interface entirely through the Gmail API, with no browser involved.

**How it works technically:**

Gmail's inbox categories are standard system labels with fixed IDs:

| Tab Label   | Gmail Label ID          |
|-------------|-------------------------|
| Primary     | `CATEGORY_PRIMARY`      |
| Social      | `CATEGORY_SOCIAL`       |
| Promotions  | `CATEGORY_PROMOTIONS`   |
| Updates     | `CATEGORY_UPDATES`      |
| Forums      | `CATEGORY_FORUMS`       |

When a category tab is selected, the message list simply filters threads by that label ID instead of `INBOX`. "Primary" is the default active tab and shows `CATEGORY_PRIMARY` threads. Switching tabs fires a new `get_threads` command with the corresponding label ID.

**UI behavior:**
- Tabs only appear when the currently selected sidebar item is "Inbox" — they are hidden for all other labels, search results, Sent, Drafts, etc.
- Each tab shows its own unread count badge pulled from the label's `messagesUnread` field
- Active tab is visually highlighted
- Tabs are horizontally scrollable if window is narrow
- "Primary" is always shown; Social, Promotions, Updates, Forums are only shown if the user has them enabled in Settings → Accounts → Inbox Categories (per-account toggle)
- If all category tabs are disabled, the tab bar is hidden entirely and Inbox shows all messages as a flat list

**`InboxCategoryTabs.tsx` props:**
```typescript
interface InboxCategoryTabsProps {
  accountId: string
  activeCategory: GmailCategoryLabelId | 'ALL'
  enabledCategories: GmailCategoryLabelId[]
  unreadCounts: Record<GmailCategoryLabelId, number>
  onTabChange: (category: GmailCategoryLabelId | 'ALL') => void
}

type GmailCategoryLabelId =
  | 'CATEGORY_PRIMARY'
  | 'CATEGORY_SOCIAL'
  | 'CATEGORY_PROMOTIONS'
  | 'CATEGORY_UPDATES'
  | 'CATEGORY_FORUMS'
```

**Tauri command addition for category unread counts:**
```rust
#[tauri::command]
async fn get_category_unread_counts(account_id: String) -> Result<CategoryUnreadCounts>
// Returns unread count per CATEGORY_* label ID, fetched from labels list API
```

**Sync consideration:** The background sync engine must update unread counts for all `CATEGORY_*` labels on each incremental sync, not just `INBOX`, so tab badges stay accurate in real time.

---

### Message List
- Each row shows: avatar/initial, sender name, subject, snippet, relative time, unread dot, star icon, attachment icon
- Unread messages: bold sender + subject
- Selected message: highlighted row
- Hover actions: archive, delete, snooze (visible on hover)
- Infinite scroll with virtual list (`@tanstack/virtual` recommended for performance)
- Multi-select with checkboxes

### Message View
- Full thread display (all messages in thread collapsed except the last)
- Click to expand any message in thread
- HTML body rendering: see dedicated subsection below — this is more involved than "call DOMPurify"
- Inline attachments rendered
- Attachment list at bottom with download buttons (via Tauri `fs` plugin)
- Reply/Reply All/Forward buttons at bottom of thread
- Label chips displayed under subject

### HTML Email Rendering (non-trivial — budget real time)

DOMPurify alone is not enough. Real-world emails contain deeply nested tables, Outlook/MSO conditional comments, inline CSS with `!important`, `cid:` references to inline images, tracking pixels, and styles that will visually destroy the surrounding app UI if rendered into the main DOM.

**Architecture:** render each message body inside a **sandboxed `<iframe>`**, not via `dangerouslySetInnerHTML` into the main React tree.

- Iframe `sandbox` attribute: `sandbox="allow-same-origin"` only (no scripts, no forms, no top-level navigation, no popups).
- Iframe content built in Rust: sanitize with `ammonia` (Rust-side, stricter than DOMPurify and removes the trip through JS), then wrap in a minimal HTML shell with a strict CSP `<meta>` tag:
  ```
  default-src 'none';
  img-src cid: data: https: (only if user clicked "Load external images");
  style-src 'unsafe-inline';
  font-src data:;
  ```
- Block all remote resources by default. Show a "Load external images" button that rebuilds the iframe with `img-src https:` allowed.
- Resolve `cid:` image references via a Tauri custom protocol (`tauri://attachment/{account_id}/{message_id}/{cid}`) that streams attachment bytes from the local cache.
- Height handling: post the rendered document height from the iframe via `postMessage` so the parent can auto-size it. Do this on load and on `ResizeObserver` fire.
- Dark mode: inject a scoped stylesheet that inverts light backgrounds only when the user has dark mode enabled, and only for messages whose body doesn't declare its own dark theme. Test on real emails — many will look ugly in forced dark mode and that's acceptable for v1.

**Tracking pixel policy:** block by default via the image rule above. No separate "strip trackers" pass needed — if external images are blocked, trackers don't fire. Document this in settings.

**What to accept as v1:** some emails will render imperfectly. Outlook MSO-only layouts, legacy HTML4 font tags, and marketing emails with nested <table> layouts that assume a 600px viewport will all look less polished than in Gmail's web UI. That's fine for v1 — don't try to match Gmail's rendering pixel-for-pixel.

### Tauri Commands for UI
```rust
#[tauri::command]
async fn get_threads(account_id: String, label_id: String, page: u32) -> Result<Vec<ThreadSummary>>

#[tauri::command]
async fn get_thread_detail(account_id: String, thread_id: String) -> Result<ThreadDetail>

#[tauri::command]
async fn get_message_body(account_id: String, message_id: String) -> Result<MessageBody>

#[tauri::command]
async fn archive_thread(account_id: String, thread_id: String) -> Result<()>

#[tauri::command]
async fn star_message(account_id: String, message_id: String, starred: bool) -> Result<()>

#[tauri::command]
async fn mark_read(account_id: String, message_ids: Vec<String>, read: bool) -> Result<()>

#[tauri::command]
async fn move_to_label(account_id: String, thread_id: String, label_id: String) -> Result<()>

#[tauri::command]
async fn delete_thread(account_id: String, thread_id: String) -> Result<()>
```

**Deliverable:** Clicking labels in sidebar populates message list; clicking a thread shows full message content.

---

## Phase 7: Compose & Send

**Goal:** Users can compose new messages, reply, reply-all, and forward.

### Dependencies to add
- **Cargo.toml:** `lettre = { version = "0.11", default-features = false, features = ["builder"] }` — used only for MIME message construction, not SMTP transport.
- **package.json:** `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link` — TipTap over Quill (more active, better TS types, lighter bundle).

### Compose Window
- Opens as a separate floating panel (not a full window replacement)
- Rich text toolbar: bold, italic, underline, bullet list, numbered list, link
- Use `TipTap` or `Quill` for the editor — outputs HTML
- To/CC/BCC fields with autocomplete from sent history and contacts (local cache only)
- Subject line
- Alias selector (dropdown if account has aliases — fetched from Gmail settings API)
- Attachment area: drag-and-drop or click to browse (via Tauri `dialog` plugin)
- Character/attachment size indicator
- "Send" button, "Save Draft" button, "Discard" button

### Reply Window
- Pre-populate To (from original sender), Subject (prepend "Re: ")
- Quote original message below compose area (collapsed by default, expandable)
- Reply-All: populate all recipients minus self

### Forward
- Pre-populate Subject (prepend "Fwd: ")
- Inline quoted original message body

### Sending Flow
1. Compose MIME message in Rust (use `lettre` crate for MIME building)
2. Base64url-encode the raw RFC 2822 message
3. POST to `gmail.users.messages.send`
4. On success: add message to Sent label in local cache, close compose window
5. On failure: show error toast, keep compose window open with content intact

### Draft Auto-save
- Auto-save draft every 30 seconds while compose is open
- On close without sending: prompt "Save draft or discard?"
- Drafts synced with Gmail drafts API

### Tauri Commands
```rust
#[tauri::command]
async fn send_email(account_id: String, message: ComposeMessage) -> Result<String>

#[tauri::command]
async fn save_draft(account_id: String, message: ComposeMessage, draft_id: Option<String>) -> Result<String>

#[tauri::command]
async fn get_drafts(account_id: String) -> Result<Vec<DraftSummary>>

#[tauri::command]
async fn delete_draft(account_id: String, draft_id: String) -> Result<()>
```

**Deliverable:** User can compose and send a real email from within the app.

---

## Phase 8: Search

**Goal:** Full Gmail-powered search via the Gmail API.

### Search Behavior
- Search bar in the top of the message list pane
- Queries passed directly to Gmail API `q` parameter (supports all Gmail search operators)
- Results replace current thread list view
- Show "Searching..." spinner while waiting
- Display result count
- Clear button to return to previous label view
- Recent searches stored locally (last 20, persisted to SQLite)

### Search Query Passthrough
- Support Gmail operators: `from:`, `to:`, `subject:`, `has:attachment`, `label:`, `is:unread`, `before:`, `after:`, `larger:`, `smaller:`, etc.
- No need to build a local search index — Gmail API handles this

### Tauri Command
```rust
#[tauri::command]
async fn search_messages(account_id: String, query: String, page_token: Option<String>) -> Result<SearchResults>
```

**Deliverable:** Typing in search bar returns real Gmail search results.

---

## Phase 9: Labels Management

**Goal:** Full label CRUD within the app.

### Features
- View all labels in sidebar
- Create new label (name + color picker)
- Rename label
- Delete label (with confirmation — warns that it removes label from all messages)
- Apply/remove labels from messages via right-click context menu or toolbar dropdown
- Color-coded label chips in message view

### Tauri Commands
```rust
#[tauri::command]
async fn create_label(account_id: String, name: String, color: Option<LabelColor>) -> Result<Label>

#[tauri::command]
async fn update_label(account_id: String, label_id: String, update: LabelUpdate) -> Result<Label>

#[tauri::command]
async fn delete_label(account_id: String, label_id: String) -> Result<()>

#[tauri::command]
async fn apply_label_to_thread(account_id: String, thread_id: String, label_id: String) -> Result<()>

#[tauri::command]
async fn remove_label_from_thread(account_id: String, thread_id: String, label_id: String) -> Result<()>
```

**Deliverable:** Labels can be created, edited, deleted, and applied to messages.

---

## Phase 10: Desktop Notifications

**Goal:** Push-style notifications for new emails using periodic polling.

### Notification Strategy
- Poll for new messages every 90 seconds using Gmail history API (reuses the Phase 5 sync loop — do not run a second polling timer)
- On new messages detected: fire OS desktop notification via `@tauri-apps/plugin-notification`
- Notification shows: sender name, subject, snippet
- Clicking notification: brings app to front, navigates to that message
- Per-account notification toggle in settings
- Respect OS Do Not Disturb / Focus modes (handled by OS automatically)

### Future: Gmail Pub/Sub push (post-v1)

Polling every 90s is fine for v1 but burns quota and delays notification by up to the poll interval. Gmail supports **push notifications via Google Cloud Pub/Sub** (`users.watch` endpoint) — this is how native clients typically get instant notification.

Not a fit for v1 because:
- Requires a Cloud Pub/Sub topic in the user's Google Cloud project (adds to BYOC setup complexity).
- Requires an HTTPS endpoint to receive push messages — we would need to either run a local listener behind a tunnel or have the app subscribe pull-style from Pub/Sub.
- The pull subscription model works without an inbound endpoint and fits a desktop app, but it's a meaningful engineering lift.

Revisit in a post-v1 milestone once polling quota proves insufficient or user feedback demands sub-minute latency.

### Tray Icon
- System tray icon showing unread count badge
- Left-click: show/hide main window
- Right-click menu: "Open", per-account "Mark all read", "Quit"

**Deliverable:** New emails trigger OS desktop notifications with sender/subject.

---

## Phase 11: Settings

**Goal:** Persistent user preferences stored locally.

### Dependencies to add
- **Cargo.toml:** `tauri-plugin-store = "2"`
- **package.json:** `@tauri-apps/plugin-store`

### Settings Categories

**Accounts**
- List all accounts with email, remove account option
- Per-account: notification schedule (always / work hours only / never)
- Per-account: **Inbox Categories** — toggle each category tab on/off independently
  - Social (on/off)
  - Promotions (on/off)
  - Updates (on/off)
  - Forums (on/off)
  - Primary is always shown and cannot be disabled
  - Changes take effect immediately — tab bar re-renders without restart
- Add new account flow

**Appearance**
- Theme: system / light / dark
- Message list density: comfortable / compact
- Font size: small / medium / large
- Show/hide preview pane

**Compose**
- Default reply behavior: reply / reply all
- Confirm before sending (toggle)
- Undo send delay: off / 5s / 10s / 30s

**Privacy**
- Block external images by default (toggle)
- Clear local cache button

### Storage
- Settings stored as JSON in Tauri's app data directory
- Use `tauri-plugin-store` for simple key-value persistence
- Each setting change auto-saved immediately

---

## Phase 12: Polish & Cross-Platform QA

**Goal:** Consistent experience across all 3 platforms before initial release.

### Tasks

**macOS**
- Native window traffic light buttons (close/minimize/maximize) visible
- Cmd+K for search, standard Mac shortcuts (Cmd+N compose, Cmd+R reply, etc.)
- Touch Bar support (optional/stretch goal)
- Notarization setup for distribution

**Windows**
- Title bar styling consistent with Windows 11 design
- Windows notification integration
- Installer via `tauri build` (produces `.msi`)
- Ctrl+K search, standard Windows shortcuts

**Linux**
- Test on Ubuntu (GTK), Fedora, Arch
- Proper `.deb` and `.AppImage` build outputs
- Fallback for systems without keyring daemon (prompt user / warn)

**General Polish**
- Loading skeletons on initial data fetch (no blank white flashes)
- Error states for network failures with retry buttons
- Empty states (empty inbox, no search results, etc.)
- Keyboard navigation: Tab through panes, Enter to open, E to archive, # to delete, R to reply
- Accessibility: ARIA labels on all interactive elements, focus rings visible

---

## Error Handling Strategy

All Tauri commands return `Result<T, String>` where the `String` is a human-readable error message displayed as a toast in the UI. Internally, use `anyhow::Result` throughout Rust code and map to string at the command boundary.

Error categories:
- `AuthError` — token expired, revoked, invalid credentials
- `NetworkError` — offline, timeout, DNS failure
- `RateLimitError` — 429, back off and retry silently
- `ApiError` — unexpected Gmail API response (log and surface)
- `DbError` — SQLite failure (critical, log with full context)
- `SyncError` — incremental sync failed, trigger full re-sync

---

## Testing Plan

### Rust Unit Tests
- Gmail API type deserialization (test against saved JSON fixtures)
- MIME message parsing (test multipart/html/plain/attachment cases)
- OAuth PKCE flow (mock HTTP server)
- Database queries (in-memory SQLite for tests)
- Sync engine logic (mock Gmail client)

### Frontend Tests
- Component tests with Vitest + Testing Library
- Store state transitions
- Message rendering with XSS test cases (DOMPurify validation)

### Integration Tests
- End-to-end with real Google account in CI (using a dedicated test account)
- Platform builds: verify `.dmg`, `.msi`, `.AppImage` all produce and run

---

## Build & Release

### Development
```bash
npm run tauri dev          # hot-reload dev mode
cargo test -p gmail-client # run Rust tests
npm run test               # run frontend tests
```

### Production Build
```bash
npm run tauri build        # produces platform binaries in src-tauri/target/release/bundle/
```

### Output Artifacts
- macOS: `gmail-client.dmg` + `gmail-client.app`
- Windows: `gmail-client_x.x.x_x64.msi` + `gmail-client_x.x.x_x64-setup.exe`
- Linux: `gmail-client_x.x.x_amd64.deb` + `gmail-client_x.x.x_x86_64.AppImage`

### CI/CD (GitHub Actions)
- Build matrix: `macos-latest`, `windows-latest`, `ubuntu-latest`
- Run tests on every PR
- Build release binaries on version tag push
- Upload artifacts to GitHub Releases

---

## Phase Summary & Suggested Order for Claude Code

| Phase | Focus | Estimated Complexity |
|-------|-------|----------------------|
| 1 | Scaffolding & tooling | Low |
| 2 | Database & migrations | Low |
| 3 | OAuth2 / onboarding | Medium |
| 4 | Gmail API client layer | Medium-High |
| 5 | Background sync engine | High |
| 6 | Core UI — 3-pane layout + inbox category tabs | Medium-High |
| 7 | Compose & send | Medium |
| 8 | Search | Low |
| 9 | Labels management | Low-Medium |
| 10 | Desktop notifications | Low |
| 11 | Settings (incl. per-account category toggles) | Low |
| 12 | Polish & cross-platform QA | Medium |

**Recommended approach for Claude Code:** Work through phases sequentially. Complete and verify each phase before moving to the next. Start each session by asking Claude Code to read this document in full, then state which phase you are working on.

---

## Key Implementation Notes for Claude Code

- Always use `async/await` throughout Rust — all I/O is async
- All Tauri commands must be registered in `lib.rs` via `.invoke_handler(tauri::generate_handler![...])`
- Frontend should never call Gmail API directly — all API access goes through Tauri commands
- Use optimistic UI updates: apply changes locally immediately, then sync with API, roll back on failure
- The `account_id` (UUID) must be passed to every command — all operations are per-account
- HTML email bodies must always be sanitized with DOMPurify before rendering — never use dangerouslySetInnerHTML with raw API content
- Store token encryption key in OS keychain, not in app config files
- Test the OAuth redirect listener on all 3 platforms — port binding behavior differs slightly
- Inbox category tabs are **not** a special API feature — they are ordinary Gmail label IDs (`CATEGORY_PRIMARY`, `CATEGORY_SOCIAL`, etc.) filtered the same way as any other label. Never treat them as a special code path; the `get_threads` command accepts any label ID
- The tab bar component should be fully controlled by the `uiStore` — active tab and enabled tabs list live in Zustand state, persisted via `tauri-plugin-store`

---

*This document is the complete project specification. Provide it in full at the start of each Claude Code session and reference the specific phase being worked on.*
