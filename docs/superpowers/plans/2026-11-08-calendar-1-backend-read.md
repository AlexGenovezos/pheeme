# Calendar step 1: backend read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pheeme can be granted calendar access per account, keeps every account's Google calendars and events in SQLite up to date, and answers "which events fall in this range" from the cache, with repeating events expanded locally.

**Architecture:** A Tauri-free `calendar/` service with its own run loop, kept apart from the mail sync. It talks to the Calendar API through `GmailClient`'s plumbing pointed at the Calendar root (as `gmail/people.rs` does), behind a `CalendarApi` trait with an in-memory fake. Sync is `syncToken` per calendar with `singleEvents=false`, and occurrences are expanded at read time with the `rrule` crate. Access comes from an incremental OAuth consent (`ClientChoice::Calendar`).

**Tech Stack:** Rust, sqlx (SQLite, `query_as!` with offline `.sqlx`), `rrule` 0.14 (+ `chrono-tz`), wiremock for client tests, Tauri commands, TypeScript wrappers and browser-preview handlers.

**Spec:** `docs/superpowers/specs/2026-11-08-calendar-design.md` (this plan is §9 step 1; §5 constraints, §6 calls 2, 3, 5, 6, 13, 14).

## Global Constraints

- Scopes requested for calendar: `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.settings.readonly`, `https://www.googleapis.com/auth/tasks`. Never `https://www.googleapis.com/auth/calendar`.
- Calendar access is never requested until the user asks for it (`ClientChoice::Calendar`). Plain sign-in keeps requesting only `auth::SCOPES`.
- Every authorization URL carries `include_granted_scopes=true`, so signing in again for mail keeps calendar access.
- Calendar API root: `https://www.googleapis.com/calendar/v3`.
- Sync cadence: 60 s, or 15 s while the frontend says Calendar mode is in front; the calendar list and settings are re-read at most every 15 min; an account whose status is `missing_scope` or `api_disabled` isn't polled until it's granted again or "Check again" is pressed.
- A calendar sync failure never touches mail sync or blocks it: separate loop, separate client instance.
- Times: UTC milliseconds plus the IANA zone. All-day events are stored as `YYYY-MM-DD` dates (end exclusive, as Google sends them) and never shifted.
- Commands follow CLAUDE.md: thin adapter in `commands/calendar.rs`, registered in `lib.rs`, typed wrapper in `src/lib/tauri.ts`, and user-initiated Google calls wrapped in `gmail::user_action`.
- After schema/query changes: `cargo sqlx prepare` (from `src-tauri/`), commit `.sqlx/`.
- Heavy jobs go through `pnpm`/`heavy` (devbox rule): run cargo as `heavy cargo test …`.

## Review Focus

1. **Signing in again for mail after allowing calendar.** Calendar must still work: the Reconnect URL carries `include_granted_scopes=true` (Task 1 test `authorization_url_always_includes_granted_scopes`).
2. **An all-day event viewed from a zone west of UTC.** It must stay on its date, with no conversion through a timestamp at expansion (Task 4 test `all_day_series_keeps_dates`).
3. **A repeating meeting where one occurrence was moved to another week, and one was cancelled.** The moved one appears once, at its new time, even when the new time is outside the original week. The cancelled one is gone (Task 4 tests `moved_occurrence_appears_once_at_new_time`, `cancelled_occurrence_is_skipped`; Task 6 test `range_includes_override_moved_into_range`).
4. **Google answers 410 Gone to a stored sync token.** The calendar is re-synced in full and the old events don't linger (Task 5 test `gone_token_resyncs_and_drops_stale_events`).
5. **An account that declined calendar access, or whose project doesn't have the Calendar API on.** It shows `missing_scope`/`api_disabled`, isn't polled every 60 s, and mail is unaffected (Task 5 test `missing_scope_marks_status_and_skips_until_reset`).

---

### Task 1: Incremental calendar consent

**Files:**
- Modify: `src-tauri/src/gmail/auth.rs` (scopes, `authorization_url`)
- Modify: `src-tauri/src/accounts.rs` (`ClientChoice::Calendar`, `begin_sign_in`, `complete_sign_in`)
- Modify: `src/lib/tauri.ts` (`ClientChoice` union)

**Interfaces:**
- Produces: `pub const CALENDAR_SCOPES: &[&str]` (the four scopes above) and `pub const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events"` in `gmail::auth`. `authorization_url(endpoints, client_id, redirect_uri, code_challenge, state, login_hint: Option<&str>, extra_scopes: &[&str]) -> String`. `ClientChoice::Calendar { account_id: String }` (serde `kind: "calendar"`). Completing a Calendar flow saves the account like Reconnect does (same email is enforced) and returns `AccountInfo`.

- [ ] **Step 1: Write the failing tests** in `auth.rs` tests:
  - `authorization_url_always_includes_granted_scopes`: the query has `include_granted_scopes == "true"` for both `extra_scopes = &[]` and `CALENDAR_SCOPES`.
  - `calendar_consent_requests_mail_and_calendar_scopes`: with `CALENDAR_SCOPES`, `scope` split on spaces equals `SCOPES` followed by `CALENDAR_SCOPES`, and doesn't contain `https://www.googleapis.com/auth/calendar` as a whole scope.

  And in `accounts.rs` tests (next to the Reconnect tests, same wiremock endpoints):
  - `calendar_consent_requires_the_same_account`: `begin_sign_in(ClientChoice::Calendar { account_id })` returns an `auth_url` with `login_hint` = the account email and `calendar.events` in `scope`. Completing as a different email gives `AccountError::WrongAccount`.
- [ ] **Step 2: Run** `heavy cargo test --manifest-path src-tauri/Cargo.toml auth:: accounts::` — expect FAIL (no such constant/variant).
- [ ] **Step 3: Implement.** Add the constants. Add the `extra_scopes` parameter, append `include_granted_scopes=true`, and update the existing callers to pass `&[]`. Add the variant, which resolves exactly like `Reconnect` and also carries `CALENDAR_SCOPES` into the URL. `PendingSignIn` doesn't need to remember the scopes.
- [ ] **Step 4: Run** the same tests, plus `heavy cargo test --manifest-path src-tauri/Cargo.toml` (whole crate, because other callers changed). Expect PASS.
- [ ] **Step 5: Update `ClientChoice` in `src/lib/tauri.ts`** with `| { kind: "calendar"; accountId: string }` and a doc comment. Run `npm run typecheck`.
- [ ] **Step 6: Commit** `feat(calendar): incremental consent for calendar and tasks scopes`.

### Task 2: Schema and cache queries

**Files:**
- Create: `src-tauri/src/db/migrations/010_calendar.sql`
- Create: `src-tauri/src/db/calendar.rs`
- Modify: `src-tauri/src/db/mod.rs` (`pub mod calendar;`)
- Modify: `src-tauri/.sqlx/` (regenerated)

**Interfaces:**
- Produces, in `db::calendar`:
  - `DbCalendar { account_id, id, summary: String, description: Option<String>, time_zone: Option<String>, background_color: Option<String>, foreground_color: Option<String>, access_role: String, primary: bool, hidden: bool, default_reminders: String /*JSON*/, sync_token: Option<String> }`
  - `DbEvent { account_id, calendar_id, id, ical_uid: Option<String>, recurring_event_id: Option<String>, original_start_ms: Option<i64>, original_start_date: Option<String>, status: String, start_ms: Option<i64>, end_ms: Option<i64>, start_date: Option<String>, end_date: Option<String>, time_zone: Option<String>, recurrence: Option<String> /*JSON array of RRULE/EXDATE/RDATE lines*/, recur_until_ms: Option<i64>, summary, location, description: Option<String>, organizer_email: Option<String>, self_response: Option<String>, attendees: String /*JSON*/, conference: Option<String> /*JSON*/, color_id: Option<String>, transparency: Option<String>, visibility: Option<String>, reminders: Option<String> /*JSON*/, html_link: Option<String>, etag: String, updated_ms: i64, raw: String /*full API JSON*/ }`
  - `replace_calendars(pool, account_id, &[DbCalendar]) -> Result<()>`: upserts. Keeps the local `hidden` and `sync_token` of rows that already exist and deletes calendars no longer listed (their events cascade).
  - `calendars(pool, account_id: Option<&str>) -> Result<Vec<DbCalendar>>`
  - `set_hidden(pool, account_id, calendar_id, hidden: bool) -> Result<()>`
  - `apply_event_changes(pool, account_id, calendar_id, upserts: &[DbEvent], deleted_ids: &[String], sync_token: Option<&str>) -> Result<()>`: one `begin_write` transaction.
  - `clear_calendar_events(pool, account_id, calendar_id) -> Result<()>`: deletes the events and nulls `sync_token`.
  - `events_overlapping(pool, from_ms, to_ms) -> Result<Vec<DbEvent>>`: rows from calendars that aren't hidden that are (a) non-recurring or override rows with `status != 'cancelled'` overlapping the range, where for all-day rows the date range is padded ±1 day so the caller trims by zone, (b) recurring masters (`recurrence IS NOT NULL`) with `start < to` and (`recur_until_ms IS NULL` or `recur_until_ms >= from`), or (c) overrides of those masters (any status, so cancellations reach expansion).
  - `access(pool, account_id) -> Result<Option<DbCalendarAccess>>` and `set_access(pool, account_id, status: &str, detail: Option<&str>, now_ms) -> Result<()>`. `DbCalendarAccess { status, detail, checked_at, synced_at, settings_checked_at: Option<i64>, time_zone: Option<String>, week_start: Option<i64> }`, plus `set_settings(pool, account_id, time_zone, week_start, now_ms)`.

- [ ] **Step 1: Write `010_calendar.sql`.** Tables:
  - `calendars`: PK `(account_id, id)`, account FK `ON DELETE CASCADE`.
  - `events`: PK `(account_id, calendar_id, id)`, FK to `calendars` `ON DELETE CASCADE`. Indexes on `(start_ms)`, `(account_id, ical_uid)`, `(account_id, calendar_id, recurring_event_id)`, and a partial index on `recurrence IS NOT NULL`.
  - `calendar_access`: PK `account_id`, cascade. `status` is `unknown | on | missing_scope | api_disabled | error`, plus `detail`, `checked_at`, `synced_at`, `settings_checked_at`, `time_zone`, `week_start`.
  
  Booleans are INTEGER.
- [ ] **Step 2: Write the failing tests** in `db/calendar.rs` (using `TestDb::with_account`):
  - `replace_calendars_keeps_hidden_and_token_and_drops_missing`: insert cal A (hidden, token "t1") and cal B. Replacing with [A'] (new summary) leaves A hidden with token "t1" and the new summary, and B and its events are gone.
  - `events_overlapping_returns_singles_masters_and_overrides`: a single event 10:00–11:00 is returned for [10:30, 12:00) and not for [11:00, 12:00). A master with `recur_until_ms` before `from` isn't returned, but one with `NULL` is. A cancelled override of a returned master is returned. A cancelled non-override row isn't stored anyway. Events in a hidden calendar aren't returned.
  - `apply_event_changes_is_atomic`: upserting + deleting + the token write all land together, and re-applying the same upsert updates in place.
- [ ] **Step 3: Run** `heavy cargo test --manifest-path src-tauri/Cargo.toml db::calendar` — FAIL.
- [ ] **Step 4: Implement** with `sqlx::query_as!`/`query!`. JSON columns are plain TEXT, and the service (de)serializes them.
- [ ] **Step 5: Run** the tests — PASS. Then from `src-tauri/`, run `cargo sqlx prepare`, and `heavy cargo check --manifest-path src-tauri/Cargo.toml` offline (`SQLX_OFFLINE=true`).
- [ ] **Step 6: Commit** `feat(calendar): schema and cache queries` (including `.sqlx/`).

### Task 3: Calendar API client

**Files:**
- Create: `src-tauri/src/gmail/calendar.rs`
- Modify: `src-tauri/src/gmail/mod.rs` (`pub mod calendar;`)
- Create: `src-tauri/src/gmail/fixtures/calendar_events.json`, `calendar_list.json` (recorded shapes from the API docs: a timed event, an all-day event, a recurring master with `recurrence`, an override with `recurringEventId`/`originalStartTime`, a cancelled override, an event with attendees/`self`/`conferenceData`)

**Interfaces:**
- Produces:
  - `pub const CALENDAR_BASE_URL: &str = "https://www.googleapis.com/calendar/v3";`
  - `impl GmailClient { pub fn calendar(tokens: Arc<dyn TokenProvider>) -> Self }`
  - `ApiCalendar { id, summary, description, time_zone, background_color, foreground_color, access_role, primary: bool, deleted: bool, default_reminders: Vec<ApiReminder> }`
  - `ApiEventTime { date: Option<String>, date_time: Option<String> /*RFC 3339*/, time_zone: Option<String> }`
  - `ApiEvent { id, status: Option<String>, ical_uid, recurring_event_id, original_start_time: Option<ApiEventTime>, start: Option<ApiEventTime>, end: Option<ApiEventTime>, recurrence: Vec<String>, summary, location, description, organizer: Option<ApiPerson>, attendees: Vec<ApiAttendee>, conference_data: Option<Value>, color_id, transparency, visibility, reminders: Option<Value>, html_link, etag: String, updated: Option<String>, raw: Value }`. `raw` is the whole object; deserialize to `Value` first, then into the typed struct.
  - `ApiAttendee { email, display_name, response_status, optional: bool, organizer: bool, is_self: bool /* "self" */, resource: bool, comment: Option<String> }`
  - `CalendarListPage { items: Vec<ApiCalendar>, next_page_token: Option<String> }`
  - `EventsPage { items: Vec<ApiEvent>, next_page_token: Option<String>, next_sync_token: Option<String> }`
  - `CalendarSettings { time_zone: Option<String>, week_start: Option<u8> }`
  - Methods: `list_calendar_list(&self, page_token: Option<&str>) -> Result<CalendarListPage, GmailError>`, `list_events(&self, calendar_id: &str, sync_token: Option<&str>, page_token: Option<&str>) -> Result<EventsPage, GmailError>` (`singleEvents=false`, `showDeleted=true`, `maxResults=2500`; the calendar id is a path segment, so it's percent-encoded by `url_for`), `calendar_settings(&self) -> Result<CalendarSettings, GmailError>` (two GETs: `users/me/settings/timezone` and `users/me/settings/weekStart`, where `weekStart` "0" is Sunday).

- [ ] **Step 1: Write the failing wiremock tests** (pattern: `gmail/people.rs` tests):
  - `lists_events_with_sync_token_and_parses_all_shapes`: the request has `syncToken=s1`, `singleEvents=false`, `showDeleted=true`. From the fixture, the timed event's `start.date_time` and `time_zone` are parsed, the all-day event's `start.date == "2026-11-12"`, the master's `recurrence[0]` starts with `RRULE:`, the override's `original_start_time` is parsed, `attendees[i].is_self` is true for the `"self": true` attendee, `raw["id"]` is set, and `next_sync_token == Some("s2")`.
  - `calendar_id_with_hash_and_at_is_encoded`: `en.usa#holiday@group.v.calendar.google.com` hits the path `/calendars/en.usa%23holiday%40group.v.calendar.google.com/events`.
  - `gone_sync_token_is_api_410`: a 410 response gives `GmailError::Api { status: 410, .. }`. Add `GmailError::is_gone(&self) -> bool` in `gmail/error.rs` and assert it.
  - `reads_timezone_and_week_start`.
- [ ] **Step 2: Run** `heavy cargo test --manifest-path src-tauri/Cargo.toml gmail::calendar` — FAIL.
- [ ] **Step 3: Implement.** If the retry loop treats 410 as retryable, make it non-retryable so `is_gone` reaches the caller (check `execute`'s status handling).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(calendar): Calendar API client`.

### Task 4: Local recurrence expansion

**Files:**
- Modify: `src-tauri/Cargo.toml` (`rrule = "0.14"`, `chrono-tz = "0.10"`, or whatever version `rrule` 0.14 depends on, so only one copy is built)
- Create: `src-tauri/src/calendar/recurrence.rs`

**Interfaces:**
- Consumes: `db::calendar::DbEvent` (Task 2).
- Produces:
  - `pub struct Occurrence { pub master_id: Option<String>, pub event_id: String, pub start_ms: Option<i64>, pub end_ms: Option<i64>, pub start_date: Option<String>, pub end_date: Option<String>, pub original_start_ms: Option<i64> }`
  - `pub fn expand(master: &DbEvent, overrides: &[&DbEvent], from_ms: i64, to_ms: i64, display_tz: chrono_tz::Tz) -> Vec<Occurrence>`. It returns the master's generated occurrences that overlap `[from_ms, to_ms)`, minus those whose original start matches an override (`original_start_ms`, or `original_start_date` for all-day ones). Overrides themselves are *not* returned here; the caller adds non-cancelled overrides as singles. Occurrence `event_id` follows Google's instance id format: `{master}_{YYYYMMDD}T{HHMMSS}Z` for timed events and `{master}_{YYYYMMDD}` for all-day ones, so later write calls can address the instance. All-day occurrences carry dates only, and `display_tz` decides which dates overlap the range. There's a hard cap of 1,000 occurrences per call.
  - `pub fn recur_until_ms(recurrence: &[String], start_ms: i64, tz: &str) -> Option<i64>`: the last occurrence's end bound from `UNTIL`/`COUNT`, or `None` for an open-ended series. Task 5 stores it.
- Approach: build an `rrule::RRuleSet` from a `DTSTART;TZID={zone}:{local}` line plus the master's `recurrence` lines (Google sends `RRULE:`, `EXDATE`, `RDATE` lines, possibly with `TZID` or `VALUE=DATE`). For all-day events, use a floating midnight `DTSTART` in UTC and map results back to dates. Duration = master end − start.

- [ ] **Step 1: Write the failing tests:**
  - `weekly_series_in_its_zone_across_dst`: the master is weekly, Mondays 09:00 `America/New_York`, starting 2026-10-26. Expanding Oct 26–Nov 16 gives 4 occurrences, all at 09:00 local: 13:00Z before Nov 1 and 14:00Z after.
  - `exdate_is_skipped`.
  - `moved_occurrence_appears_once_at_new_time`: an override with `original_start_ms` = the Nov 9 occurrence → Nov 9 isn't in the output (the override's new time is the caller's to add).
  - `cancelled_occurrence_is_skipped`: same for an override with `status = "cancelled"`.
  - `all_day_series_keeps_dates`: a daily all-day series 2026-11-10..(COUNT=3) with `display_tz = America/Los_Angeles` gives dates 11-10, 11-11 and 11-12 (end dates 11-11, 11-12, 11-13), with no `start_ms`.
  - `count_and_until_bound_series`: `recur_until_ms` is `Some` for `COUNT=3` and `UNTIL=…`, and `None` for plain `FREQ=WEEKLY`.
  - `instance_ids_match_google_format`: `abc_20261109T140000Z` and `abc_20261110`.
  - `unparseable_rule_yields_only_first_occurrence`: garbage `RRULE` → the master's own start, if it's in range, and no panic.
- [ ] **Step 2: Run** `heavy cargo test --manifest-path src-tauri/Cargo.toml calendar::recurrence` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(calendar): expand repeating events locally`.

### Task 5: Account sync

**Files:**
- Create: `src-tauri/src/calendar/mod.rs` (module root, `CalendarApi` trait, factory type)
- Create: `src-tauri/src/calendar/sync.rs`
- Create: `src-tauri/src/calendar/convert.rs` (`ApiEvent → DbEvent`, `ApiCalendar → DbCalendar`)
- Create: `src-tauri/src/calendar/fake.rs` (`#[cfg(test)]` in-memory Calendar)
- Modify: `src-tauri/src/lib.rs` (`pub mod calendar;`)

**Interfaces:**
- Consumes: Task 2's `db::calendar`, Task 3's API types, and Task 4's `recur_until_ms`.
- Produces:
  - `#[async_trait] pub trait CalendarApi: Send + Sync { async fn list_calendar_list(&self, page_token: Option<&str>) -> Result<CalendarListPage, GmailError>; async fn list_events(&self, calendar_id: &str, sync_token: Option<&str>, page_token: Option<&str>) -> Result<EventsPage, GmailError>; async fn calendar_settings(&self) -> Result<CalendarSettings, GmailError>; }`, implemented for `GmailClient`.
  - `pub type CalendarFactory = Arc<dyn Fn(&str) -> Arc<dyn CalendarApi> + Send + Sync>;`
  - `pub struct SyncReport { pub changed: bool }`
  - `pub async fn sync_account(db: &SqlitePool, api: &dyn CalendarApi, account_id: &str, now_ms: i64, refresh_list: bool) -> Result<SyncReport, GmailError>`. It reads the calendar list and settings when `refresh_list` is set or none are stored yet. Then for each calendar it pages `list_events` from the stored token (or none). Each item goes one of three ways: a cancelled non-override → its id is deleted; a cancelled override → stored, so expansion skips it; anything else → upserted, with `recur_until_ms` computed. The token is stored with the last page. On `is_gone()`, `clear_calendar_events` runs and the calendar is synced in full once. The page cap is 400 pages per calendar. A calendar whose `list_events` fails with 403/404 `notFound` is skipped for this pass, not fatal. A missing scope or disabled API anywhere is returned as an error, for the caller to classify. Returns `changed = true` if any row changed.
  - `pub fn classify(e: &GmailError) -> (&'static str, Option<String>)`: maps an error to `("missing_scope", None)`, `("api_disabled", project)` or `("error", Some(msg))` (as `contacts.rs` does).

- [ ] **Step 1: Write `fake.rs`** with per-calendar event lists, a change log so `list_events(token)` returns only changes since the token, a switch to make the next token call return 410, and switches for missing scope and disabled API.
- [ ] **Step 2: Write the failing tests** in `sync.rs`:
  - `first_sync_stores_calendars_events_and_tokens`.
  - `incremental_sync_applies_updates_and_deletes`: after the first sync, change one event and cancel another in the fake. The second sync passes the stored token, the cached rows reflect both changes, and `changed` is true. A third sync with no changes gives `changed == false`.
  - `gone_token_resyncs_and_drops_stale_events`: the fake forgets an event and returns 410 for the old token → after the sync, that event isn't in `events`, and the new token is stored.
  - `calendar_removed_from_list_drops_its_events`.
  - `missing_scope_marks_status_and_skips_until_reset`: this one runs through Task 6's service loop. Write it in Task 6 and only check `classify` here: `classify(&insufficient_scope_403) == ("missing_scope", None)` and `classify(&access_not_configured_403).0 == "api_disabled"`.
  - `override_moved_and_cancelled_are_stored_with_original_start`.
- [ ] **Step 3: Run** `heavy cargo test --manifest-path src-tauri/Cargo.toml calendar::sync` — FAIL.
- [ ] **Step 4: Implement.** In `convert.rs`: an `ApiEventTime` with `date_time` → `start_ms`. The event's `time_zone` is `start.time_zone`, falling back to the calendar's `time_zone`. `self_response` comes from the attendee with `is_self`, or `"accepted"` when the organizer is self and there are no attendees.
- [ ] **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `feat(calendar): sync calendars and events with sync tokens`.

### Task 6: Calendar service, run loop and events

**Files:**
- Create: `src-tauri/src/calendar/service.rs`
- Modify: `src-tauri/src/sync/events.rs` (new `SyncEvent` variants)
- Modify: `src-tauri/src/lib.rs` (`AppState.calendar`, factory, `tokio::spawn(calendar.clone().run())`)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `SyncEvent::CalendarUpdated { account_id: String }` → `"calendar:updated"`, and `SyncEvent::CalendarAccess { account_id: String, status: String }` → `"calendar:access"`.
  - DTOs (serde camelCase):
    - `CalendarEventDto { accountId, calendarId, id, masterId: Option<String>, summary: Option<String>, start: EventTimeDto, end: EventTimeDto, allDay: bool, status: String, selfResponse: Option<String>, location: Option<String>, hasConference: bool, colorId: Option<String>, transparency: Option<String>, recurring: bool }`
    - `EventTimeDto { ms: Option<i64>, date: Option<String>, timeZone: Option<String> }`
    - `CalendarDto { id, summary, backgroundColor, foregroundColor, accessRole, primary, hidden }`
    - `CalendarAccountDto { accountId, email, access: CalendarAccessDto, timeZone: Option<String>, weekStart: Option<u8>, calendars: Vec<CalendarDto> }`
    - `CalendarAccessDto { status: String, message: Option<String>, enableUrl: Option<String>, syncedAt: Option<i64> }`
    - `pub const CALENDAR_API_URL = "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com"` (the `enableUrl` uses the project number when Google gave one, as contacts does)
  - `CalendarService::new(db, api_for: CalendarFactory, events: Arc<dyn SyncEvents>) -> Arc<Self>`
  - `async fn accounts(&self) -> Result<Vec<CalendarAccountDto>, MailError>` (every account, including those never granted, with `status = "unknown"`)
  - `async fn events(&self, from_ms: i64, to_ms: i64, display_tz: &str) -> Result<Vec<CalendarEventDto>, MailError>`: merges `events_overlapping` across accounts, expands masters with their overrides, adds non-cancelled overrides and singles, and returns them sorted by start
  - `async fn set_calendar_hidden(&self, account_id, calendar_id, hidden: bool) -> Result<(), MailError>` (local only, then emits `CalendarUpdated`)
  - `async fn sync_now(&self, account_id: &str) -> Result<CalendarAccessDto, MailError>`: syncs right away, clearing a `missing_scope`/`api_disabled` hold. It's used by "Check again" and after the consent flow
  - `fn set_foreground(&self, on: bool)` (15 s vs 60 s), `fn trigger(&self, account_id: Option<String>)` (wakes the loop)
  - `async fn run(self: Arc<Self>)`: the loop. Each tick syncs every account whose status isn't `missing_scope`/`api_disabled` and that has been granted at least once (`calendar_access` row exists). One account at a time, holding one per-account mutex. On success: status `on`, `synced_at`, emit `CalendarUpdated` if changed. On error: `classify` → `set_access` and emit `CalendarAccess` if the status changed. Network/offline errors leave the status alone.

- [ ] **Step 1: Write the failing tests** in `service.rs` (fake API, recording `SyncEvents` as in `sync/tests.rs`):
  - `events_merges_accounts_and_expands_series`: two accounts, one weekly master + one single → the week range returns 2 items, sorted, with the correct `accountId`s.
  - `range_includes_override_moved_into_range`: the master's Nov 2 occurrence was moved to Nov 10 (an override row). Range Nov 9–16 includes the override exactly once, and range Oct 26–Nov 8 doesn't include Nov 2.
  - `hidden_calendar_events_are_left_out_and_toggle_emits_update`.
  - `missing_scope_marks_status_and_skips_until_reset`: the fake fails with insufficient scope → after a tick, status is `missing_scope` and one `CalendarAccess` event was emitted. A second tick makes no API call (count calls in the fake). `sync_now` calls the API again.
  - `accounts_lists_never_granted_accounts_as_unknown`.
- [ ] **Step 2: Run** `heavy cargo test --manifest-path src-tauri/Cargo.toml calendar::service` — FAIL.
- [ ] **Step 3: Implement.** Write the loop so tests can drive single ticks (`async fn tick(&self, now_ms: i64)`), with `run` wrapping it in a `tokio::select!` on a `Notify` and the interval.
- [ ] **Step 4: Register in `build_state`:** add `calendar_for` built like `people_for` with `GmailClient::calendar(provider)`, `AppState.calendar: Arc<calendar::CalendarService>`, and spawn `run`. In `commands/auth.rs` `complete_oauth`, call `state.calendar.trigger(Some(account.id))` after sign-in.
- [ ] **Step 5: Run** `heavy cargo test --manifest-path src-tauri/Cargo.toml` (whole crate) — PASS.
- [ ] **Step 6: Commit** `feat(calendar): calendar service with background sync`.

### Task 7: Commands, TypeScript wrappers, browser preview

**Files:**
- Create: `src-tauri/src/commands/calendar.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (`generate_handler!`)
- Modify: `src/lib/tauri.ts` (types + wrappers)
- Create: `src/preview/calendar.ts` (handlers + fixtures), and modify `src/preview/runtime.ts` to register them
- Test: `src/preview/calendar.test.ts`

**Interfaces:**
- Consumes: Task 6's DTOs and service.
- Produces (commands → wrappers):
  - `calendar_accounts` → `getCalendarAccounts(): Promise<CalendarAccount[]>`
  - `calendar_events { fromMs, toMs, timeZone }` → `getCalendarEvents(fromMs, toMs, timeZone): Promise<CalendarEvent[]>`
  - `set_calendar_hidden { accountId, calendarId, hidden }` → `setCalendarHidden(...)`
  - `calendar_sync_now { accountId }` → `calendarSyncNow(accountId): Promise<CalendarAccess>` (wrapped in `user_action`)
  - `set_calendar_foreground { on }` → `setCalendarForeground(on)`
  - TS types `CalendarAccount`, `CalendarAccess`, `CalendarInfo`, `CalendarEvent`, `EventTime`, mirroring Task 6's DTOs field for field. Events `calendar:updated` / `calendar:access` are listed next to the existing `sync:*` event names if `tauri.ts` keeps such a list.
- Preview fixtures: two accounts. The first has 3 calendars (primary, "Team", holidays) and the second has 1. A week of events around "today": a weekly standup series with one moved occurrence, lunch, an all-day holiday, a multi-day conference, an unanswered invite (`selfResponse: "needsAction"`) that clashes with a 1:1, and a declined event. `?calendar=missing_scope|api_disabled|unknown` sets the second account's access, mirroring `?contacts=`.

- [ ] **Step 1: Write the failing test** `src/preview/calendar.test.ts`: `calendar_events` for the fixture week returns the clashing invite with `selfResponse === "needsAction"` and events sorted by start. `set_calendar_hidden` removes that calendar's events from the next `calendar_events` call. `calendar_accounts` honours `?calendar=missing_scope`.
- [ ] **Step 2: Run** `npm run test -- src/preview/calendar.test.ts` — FAIL.
- [ ] **Step 3: Implement** the Rust commands (thin, `CommandError` mapping as in `commands/contacts.rs`), the registration, the wrappers and the preview handlers.
- [ ] **Step 4: Run** `npm run test -- src/preview`, `npm run typecheck`, `npm run lint`, `heavy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` — all PASS.
- [ ] **Step 5: Commit** `feat(calendar): calendar commands, typed wrappers and preview fixtures`.

### Task 8: Docs for this step

**Files:**
- Modify: `CLAUDE.md` (module table: `calendar/`; schema summary: three new tables, so "Fifteen tables"; mention `calendar:*` events)

- [ ] **Step 1: Update** the module table row and the schema list. Don't claim Calendar mode exists in the UI.
- [ ] **Step 2: Run** `npm run format:check`.
- [ ] **Step 3: Commit** `docs: calendar backend in CLAUDE.md`.
