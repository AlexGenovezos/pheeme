# Calendar step 2: backend write — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pheeme can change Google Calendar. It can create, edit, move, copy and delete events, and edit or delete a repeating event as "this event", "this and following" or "all events". It can answer invites, import an invite that isn't on the calendar, and add or remove Google Meet. Every change goes to Google first and is cached only once Google confirms it.

**Architecture:** Writes go straight to the Calendar API through the existing `CalendarApi` trait, which this step extends, not through the mail outbox (spec §6.1). The service sends the change, writes the event Google returns into the cache through `convert::event`, emits `calendar:updated` and triggers a sync of the account. The pure parts sit in their own files and are tested without a service: turning an edit into Google's JSON (`edit.rs`) and the arithmetic of repeating rules (`series.rs`). Writes that carry a stored `etag` send `If-Match`, so an event changed elsewhere answers 412 rather than being overwritten.

**Tech Stack:** Rust, sqlx (`query_as!`, offline `.sqlx`), `rrule` 0.14 + `chrono-tz` 0.10 (already in), `uuid` (already in), wiremock, Tauri commands, TypeScript wrappers and browser-preview handlers.

**Spec:** `docs/superpowers/specs/2026-11-08-calendar-design.md`. This plan covers §9 step 2, §2.4–2.5, §4 anti-goals 1–3, and §6 calls 1, 7 (the RSVP half), 9 and 13 (etags). Ticket: #228.

## Global Constraints

- **No cache write before Google confirms.** A rejected or unsent change leaves the cache as it was (anti-goal 1).
- **`sendUpdates` defaults to `none`.** Guests are emailed only when the command says `all` (anti-goal 2). The one exception is RSVP, which always sends `sendUpdates=all`, as the website does (§6.7).
- **Never request the full `calendar` scope.** Everything here works with `calendar.events`.
- **`If-Match` and retries:** any write that has a stored etag sends `If-Match: <etag>` and is marked `non_idempotent()`. Patching an occurrence that isn't stored sends no `If-Match`.
- **412 handling:** the event is fetched again and cached, and the command fails with code `conflict`. It is never retried automatically, except for RSVP (Task 8).
- **Inserts are safe to retry.** Each insert carries a client-made id (`uuid::Uuid::new_v4().simple()`: 32 hex characters, valid base32hex). A `409` on insert means an earlier attempt landed, so the service fetches that id and continues.
- **`conferenceDataVersion=1`** goes on every write whose body touches `conferenceData`, and only on those.
- **API limits (Google):** at most 5 reminder overrides; `minutes` from 0 to 40320; reminder `method` is `popup` or `email`; event `colorId` is `"1"`–`"11"`; `transparency` is `opaque` or `transparent`; `visibility` is `default`, `public`, `private` or `confidential`.
- **User-facing error codes and copy** (`calendar/error.rs`):
  - `not_found`: "That event isn't available any more."
  - `read_only`: "You can't change events on this calendar." / "Only the organizer can change this event."
  - `invalid_input`: the message names the problem.
  - `conflict`: "This event was changed somewhere else. Pheeme has loaded the latest version; make your change again."
  - `network` for an offline error: "You're offline; changes can't be saved."
  - `unconfirmed`: "Pheeme couldn't confirm the change reached Google. Your calendar will show what Google has in a moment."
  - `incomplete`: the message names what's left over.
  - `api`: "Google Calendar refused the change: {message}".
- **CLAUDE.md conventions:**
  - Thin commands live in `commands/calendar.rs`, are registered in `lib.rs` and get typed wrappers in `src/lib/tauri.ts`.
  - Every write command runs inside `gmail::user_action`.
  - Queries go in `db/calendar.rs` with `query_as!`; run `cargo sqlx prepare` and commit `.sqlx/`.
- **Heavy jobs:** run cargo through `heavy` (`heavy cargo test --manifest-path src-tauri/Cargo.toml …`). Never set `HEAVY_BYPASS`.
- **Time zones:** tests that touch dates also pass under `TZ=Asia/Tokyo` and `TZ=America/Los_Angeles` (the step 1 S1 lesson).

## Review Focus

1. **"This and following" on a series with `COUNT`.** The old and new series together must produce exactly the original occurrences, none twice and none lost. Covered by Task 4 `split_count_series_keeps_every_occurrence_once` and Task 7 `following_edit_on_count_series`.
2. **The second half of a "this and following" split fails.** If the new series was created but the old one can't be shortened, the new series is deleted again and the user sees an error. The cache is left unchanged. If that clean-up also fails, the error says some occurrences show twice. Covered by Task 7 `following_split_rolls_back_new_series_when_truncate_fails`.
3. **The event was changed on the website after Pheeme cached it.** Google answers 412, the cache gets the newer version, the error is `conflict`, and the newer version is not overwritten. Covered by Task 6 `stale_etag_refreshes_and_reports_conflict`.
4. **An insert whose reply was lost.**
   - The client's own retry leaves exactly one event (Task 1 `insert_retry_after_duplicate_returns_existing`).
   - When the error does reach the user, it says the change is unconfirmed, and the sync that follows shows the event once (Task 6 `create_with_lost_reply_is_unconfirmed_and_shows_once`).
5. **A guest edits, or answers, someone else's meeting.**
   - Editing the details is refused before anything reaches Google.
   - Answering keeps every other guest's answer intact.
   - Covered by Task 6 `guest_cannot_edit_organizers_event` and Task 8 `rsvp_keeps_other_attendees`.

---

### Task 1: Calendar API write calls

**Files:**
- Modify: `src-tauri/src/gmail/client.rs`
  - Add `ApiRequest::patch`, `ApiRequest::delete` and `ApiRequest::header(name: &'static str, value: impl Into<String>)`. Store the headers on the request and apply them in `execute` next to the bearer.
- Modify: `src-tauri/src/gmail/error.rs`
  - Add `is_conflict()` (412) and `is_duplicate()` (409).
- Modify: `src-tauri/src/gmail/calendar.rs`: the write methods and their wiremock tests.

**Interfaces:**
- Produces in `gmail::calendar`:
  - `pub enum SendUpdates { All, None }`, which serializes as `"all"` / `"none"`.
  - `pub struct WriteOptions<'a> { pub send_updates: SendUpdates, pub if_match: Option<&'a str>, pub conference: bool }`. `conference` adds `conferenceDataVersion=1`.
  - `GmailClient` methods, each returning `Result<_, GmailError>`:
    - `insert_event(&self, calendar_id: &str, body: Value, opts: WriteOptions<'_>) -> ApiEvent`. A 409 makes it `get_event` the body's `id` and return that.
    - `patch_event(&self, calendar_id: &str, event_id: &str, body: Value, opts: WriteOptions<'_>) -> ApiEvent`
    - `delete_event(&self, calendar_id: &str, event_id: &str, opts: WriteOptions<'_>) -> ()`. A 404 or 410 counts as success.
    - `get_event(&self, calendar_id: &str, event_id: &str) -> ApiEvent`
    - `move_event(&self, calendar_id: &str, event_id: &str, destination: &str, send_updates: SendUpdates) -> ApiEvent`. Always `non_idempotent()`.
    - `import_event(&self, calendar_id: &str, body: Value) -> ApiEvent`
    - `events_by_ical_uid(&self, calendar_id: &str, ical_uid: &str) -> Vec<ApiEvent>`. Sends `iCalUID`, `singleEvents=false` and `showDeleted=false`.
  - Paths are relative to `CALENDAR_BASE_URL`:
    - insert, import and list: `calendars/{cal}/events`, with `events/import` for import.
    - get, patch and delete: `calendars/{cal}/events/{id}`.
    - move: `calendars/{cal}/events/{id}/move?destination=`.

- [ ] **Step 1: Write the failing tests** in `gmail/calendar.rs`. Use wiremock, following the existing calendar tests and `client_for`. Assert:
  - `patch_sends_if_match_and_send_updates`: the `If-Match` header equals the etag, `sendUpdates=none` is in the query, and `conferenceDataVersion` is absent.
  - `patch_with_conference_sends_version_1`.
  - `patch_412_is_conflict`: `err.is_conflict()`.
  - `insert_retry_after_duplicate_returns_existing`: POST answers 409, GET `/events/{id}` answers the event, and the result is that event.
  - `delete_treats_410_as_done`.
  - `move_posts_destination`.
  - `events_by_ical_uid_queries_uid`.
  - `if_match_write_is_not_retried_on_503`: a PATCH carrying `if_match` answers 503 and the server sees exactly 1 request.
- [ ] **Step 2: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib gmail::calendar`.** Expected: fails to compile (missing methods).
- [ ] **Step 3: Implement** the methods above, the `ApiRequest` additions and the error helpers. Leave `quota_units` at its default (it's Gmail's table).
- [ ] **Step 4: Run the same command.** Expected: PASS. Then run all `gmail::` tests: PASS.
- [ ] **Step 5: Commit** `feat(calendar): Calendar API write calls with etags`.

### Task 2: Write calls on the trait and the fake

**Files:**
- Modify: `src-tauri/src/calendar/mod.rs`: add the Task 1 methods to `CalendarApi` and delegate them in `impl CalendarApi for GmailClient`.
- Modify: `src-tauri/src/calendar/fake.rs`.

**Interfaces:**
- Consumes: Task 1's signatures. The trait methods have the same names and arguments.
- Produces on `FakeCalendar`:
  - `writes() -> Vec<FakeWrite>`, where `pub struct FakeWrite { pub method: &'static str, pub calendar_id: String, pub event_id: Option<String>, pub send_updates: Option<SendUpdates>, pub if_match: Option<String>, pub conference: bool, pub body: Value }`. `method` is one of `"insert"`, `"patch"`, `"delete"`, `"move"` or `"import"`.
  - `fail_write(n: usize, make: fn() -> GmailError)`: the n-th write from now (0-based) fails without applying.
  - `lose_reply(n: usize)`: the n-th write from now applies, then answers `GmailError::Network` (the reply was lost).
  - `event(calendar_id, id) -> Option<Value>`: the newest version of an event, for assertions.
- Fake behaviour:
  - Every write `put`s a new version with etag `"\"v{seq}\""`, so sync sees it.
  - An `if_match` that differs from the current etag answers 412.
  - Inserting an existing id answers 409.
  - Patching an id `{master}_{suffix}` that has no event of its own creates an override: the master's JSON merged with the body, plus `recurringEventId` and `originalStartTime` taken from the suffix. Deleting such an id `put`s a cancelled override with those two fields.
  - Patch merges keys at the top level. A `null` removes the key.
  - Move puts the event in the destination calendar and cancels it in the source.
  - `events_by_ical_uid` matches `iCalUID`.

- [ ] **Step 1: Write the failing tests** in `calendar/fake.rs` (`#[cfg(test)] mod tests`):
  - `patch_with_stale_etag_is_412`.
  - `patch_instance_creates_override_seen_by_sync`: after a patch on `standup_20261110T140000Z`, `list_events` with the previous sync token returns an item whose `recurringEventId == "standup"`.
  - `fail_write_fails_only_the_nth`.
- [ ] **Step 2: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib calendar::fake`.** Expected: compile failure.
- [ ] **Step 3: Implement** the trait additions and the fake.
- [ ] **Step 4: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib calendar`.** Expected: PASS, including every step 1 calendar test.
- [ ] **Step 5: Commit** `test(calendar): fake Calendar API writes`.

### Task 3: Edits as Google JSON, and the error type

**Files:**
- Create: `src-tauri/src/calendar/edit.rs`
- Create: `src-tauri/src/calendar/error.rs`
- Modify: `src-tauri/src/calendar/mod.rs` (`pub mod edit; pub mod error;`)
- Modify: `src-tauri/src/commands/mod.rs` (`impl From<CalendarError> for CommandError`)

**Interfaces:**
- Produces `calendar::error::CalendarError`, a `thiserror` enum:
  - Variants: `NotFound`, `ReadOnly(String)`, `Invalid(String)`, `Conflict`, `Offline`, `Unconfirmed`, `Incomplete(String)`, `Google(GmailError)`, `Db(anyhow::Error)`. `From<anyhow::Error>` and `From<sqlx::Error>` go to `Db`.
  - `From<GmailError>`:
    - `Offline` becomes `Offline`.
    - `Network` becomes `Unconfirmed`.
    - 412 becomes `Conflict`.
    - 404 becomes `NotFound`.
    - Everything else becomes `Google`.
  - `code()` and the `Display` copy are exactly as listed in Global Constraints. `Google(e)` takes its code from `e.code()`, and its message uses the API `message` when there is one.
- Produces in `calendar::edit`, with every input struct `Deserialize` and `#[serde(rename_all = "camelCase")]`:
  - `pub struct TimeInput { pub ms: Option<i64>, pub date: Option<String>, pub time_zone: Option<String> }`: exactly one of `ms` / `date`.
  - `pub struct AttendeeInput { pub email: String, #[serde(default)] pub optional: bool }`
  - `pub struct ReminderInput { pub method: String, pub minutes: i64 }`
  - `pub struct RemindersInput { pub use_default: bool, #[serde(default)] pub overrides: Vec<ReminderInput> }`
  - `#[derive(Default)] pub struct EventEdit`, where `None` leaves a field as it is:
    - Text fields: `summary`, `description`, `location`, `color_id`, each `Option<String>`. `Some("")` clears the field.
    - `start` and `end`: `Option<TimeInput>`.
    - `recurrence: Option<Vec<String>>`. `Some(vec![])` stops repeating.
    - `attendees: Option<Vec<AttendeeInput>>`.
    - `guests_can_modify`, `guests_can_invite_others`, `guests_can_see_other_guests`: `Option<bool>`.
    - `conference: Option<bool>`. `true` adds Meet, `false` removes it.
    - `reminders: Option<RemindersInput>`.
    - `transparency` and `visibility`: `Option<String>`.
  - `pub fn validate(edit: &EventEdit, creating: bool) -> Result<(), CalendarError>`. Returns `Invalid` when:
    - `start` and `end` aren't both present or both absent (both are required when `creating`);
    - one is all-day and the other timed;
    - the end isn't after the start;
    - a time zone isn't IANA;
    - a recurrence line doesn't start with `RRULE:`, `EXDATE`, `RDATE` or `EXRULE`;
    - an email has no `@`;
    - any Global Constraints limit is broken.
  - `pub fn body(edit: &EventEdit, existing: Option<&Value>, default_zone: &str) -> Value`: the JSON for insert or patch.
    - A timed time becomes `{"dateTime": RFC 3339 in its zone, "timeZone": zone, "date": null}`; a missing zone uses `default_zone`.
    - An all-day time becomes `{"date": d, "dateTime": null, "timeZone": null}`. The explicit nulls let a patch switch an event between timed and all-day.
    - Cleared strings become `null`.
    - `attendees` are merged with `existing["attendees"]` by lowercase email. A kept attendee keeps its whole existing object (`responseStatus`, `comment`, …) with only `optional` replaced. A new attendee is `{email, optional}`.
    - Meet on, when `existing` has no `conferenceData`, gives `{"conferenceData": {"createRequest": {"requestId": <uuid>, "conferenceSolutionKey": {"type": "hangoutsMeet"}}}}`. Meet off gives `"conferenceData": null`.
    - Reminders become `{"useDefault", "overrides"}`.
  - `pub fn touches_conference(edit: &EventEdit, existing: Option<&Value>) -> bool`: whether the write needs `conferenceDataVersion=1`.
  - `pub enum OriginalStart { Ms(i64), Date(chrono::NaiveDate) }`.
  - `pub fn parse_instance_id(id: &str) -> Option<(String, OriginalStart)>`: splits at the last `_`. The suffix is `YYYYMMDDTHHMMSSZ` (UTC) or `YYYYMMDD`.
  - `pub fn instance_id(master: &str, at: &OriginalStart) -> String`: the inverse.

- [ ] **Step 1: Write the failing tests** in `edit.rs`:
  - `timed_body_uses_event_zone_offset`: 2026-11-12 19:00 UTC with zone `America/New_York` gives `"dateTime": "2026-11-12T14:00:00-05:00"`.
  - `all_day_body_nulls_date_time`.
  - `cleared_location_is_null`.
  - `attendee_merge_keeps_existing_status`: the existing guest keeps `responseStatus: "accepted"` and `comment`; the new guest has only `email` and `optional`.
  - `meet_on_adds_create_request_once`: no request when `existing` already has `conferenceData`.
  - `meet_off_nulls_conference`.
  - `validate_rejects`: a table covering each `Invalid` rule, including 6 reminders, minutes 40321, `colorId "12"`, an end equal to the start, and the zone `"Mars/Base"`.
  - `instance_id_round_trips`: both suffix forms, plus a master id that itself contains `_`.
  - In `error.rs`, `gmail_errors_map_to_calendar_codes`: covers Offline, Network, 412, 404 and 500.
- [ ] **Step 2: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib calendar::edit calendar::error`.** Expected: compile failure.
- [ ] **Step 3: Implement** `edit.rs`, `error.rs` and the `CommandError` conversion.
- [ ] **Step 4: Run the same command, then repeat it with `TZ=Asia/Tokyo`.** Expected: PASS both times.
- [ ] **Step 5: Commit** `feat(calendar): event edits as Calendar API JSON`.

### Task 4: Repeating-rule arithmetic

**Files:**
- Create: `src-tauri/src/calendar/series.rs` (`pub mod series;` in `mod.rs`)
- Modify: `src-tauri/src/calendar/recurrence.rs`: expose `pub(crate) fn rule_count_before(master: &DbEvent, at: &OriginalStart) -> usize`, which counts occurrences of the RRULE lines alone (no EXDATE) starting before `at`. Build it on the existing `rule_text`.

**Interfaces:**
- Consumes: `edit::OriginalStart`, `recurrence::expand`, `DbEvent`.
- Produces in `calendar::series`:
  - `pub struct Split { pub old: Vec<String>, pub new: Vec<String> }`.
  - `pub fn split(master: &DbEvent, at: &OriginalStart) -> Result<Option<Split>, CalendarError>`. Returns `Ok(None)` when `at` is the series' first occurrence, which the caller then treats as "all events".
    - **`old`:** each RRULE's `COUNT` or `UNTIL` is replaced by `UNTIL`. For a timed series that's one second before `at` in UTC, as `YYYYMMDDTHHMMSSZ`; for an all-day series it's the day before, as `YYYYMMDD`. Only EXDATE/RDATE values before `at` are kept.
    - **`new`:** a series' `UNTIL` is kept; a `COUNT` becomes the old count minus `rule_count_before`. Only EXDATE/RDATE values at or after `at` are kept.
  - `pub fn truncate(master: &DbEvent, at: &OriginalStart) -> Result<Option<Vec<String>>, CalendarError>`: `split(..).map(|s| s.old)`, for "delete this and following".
  - `pub fn shift_days(recurrence: &[String], days: i64) -> Result<Vec<String>, CalendarError>`, for an "all events" move that changes the date.
    - Each `BYDAY` weekday code moves by `days` and keeps its ordinal prefix, so `2TU` with +1 becomes `2WE`.
    - A plain `BYMONTHDAY` moves too.
    - Returns `Invalid("Change the day for this series from Repeat in the editor.")` for `BYSETPOS`, or when a `BYMONTHDAY` would leave 1–28.

- [ ] **Step 1: Write the failing tests** in `series.rs`. Build masters with a small `DbEvent` helper like the one in `recurrence.rs`'s tests. For each one, expand old and new over the whole span and compare with expanding the original:
  - `split_count_series_keeps_every_occurrence_once`: weekly, `COUNT=10`, split at the 4th occurrence. The old series has 3, the new has 7, and the union equals the original.
  - `split_until_series`.
  - `split_all_day_series_uses_date_until`: the old series has `UNTIL=20261110` when split at 2026-11-11.
  - `split_keeps_exdates_on_their_side`.
  - `split_at_first_occurrence_is_none`.
  - `shift_days_moves_weekdays`: `BYDAY=MO,WE` with +1 gives `TU,TH`; `BYDAY=SU` with +1 gives `MO`.
  - `shift_days_refuses_bysetpos`.
- [ ] **Step 2: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib calendar::series`.** Expected: compile failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command under `TZ=UTC`, `TZ=Asia/Tokyo` and `TZ=America/Los_Angeles`.** Expected: PASS all three.
- [ ] **Step 5: Commit** `feat(calendar): split and shift repeating rules`.

### Task 5: Event detail and the write plumbing

**Files:**
- Modify: `src-tauri/src/db/calendar.rs`:
  - `event(pool, account, calendar, id) -> Option<DbEvent>`
  - `events_by_ical_uid(pool, account, uid) -> Vec<DbEvent>`
  - `delete_overrides_from(pool, account, calendar, master_id, from_ms: i64) -> u64`: deletes overrides whose original start (`original_start_ms`, all-day included) is at or after `from_ms`.
- Create: `src-tauri/src/calendar/writes.rs`: `impl CalendarService` for the write paths. Make the service fields `pub(super)` so this module can use them.
- Modify: `src-tauri/src/calendar/service.rs`: `EventDetailDto` and `event_detail`.

**Interfaces:**
- Produces in `calendar::service`:
  - `pub struct PersonDto { pub email: Option<String>, pub name: Option<String>, pub is_self: bool }`.
  - `pub struct AttendeeDto { pub email: Option<String>, pub name: Option<String>, pub response: Option<String>, pub optional: bool, pub organizer: bool, pub is_self: bool, pub resource: bool, pub comment: Option<String> }`.
  - `pub struct ReminderDto { pub method: String, pub minutes: i64 }`.
  - `pub struct RemindersDto { pub use_default: bool, pub overrides: Vec<ReminderDto> }`.
  - `pub struct EventDetailDto`, serialized camelCase, containing:
    - `#[serde(flatten)] pub event: CalendarEventDto`;
    - `description`, `organizer: Option<PersonDto>`, `attendees: Vec<AttendeeDto>`;
    - `meet_url: Option<String>`, the first `video` entry point; `conference_pending: bool`;
    - `recurrence: Vec<String>`, the series' lines (also given for an occurrence);
    - `original_start: Option<EventTimeDto>`, `reminders: RemindersDto`;
    - `visibility`, `html_link`;
    - `guests_can_modify`, `guests_can_invite_others`, `guests_can_see_other_guests` (Google's defaults when absent: false, true, true);
    - `can_edit`, `can_rsvp`, `can_delete`.
  - `CalendarService::event_detail(&self, account_id: &str, calendar_id: &str, event_id: &str) -> Result<EventDetailDto, CalendarError>`.
    - An instance id with no stored row is answered from its master, at the occurrence's times. The end is the start plus the master's length.
- Produces in `writes.rs` (`pub(super)`):
  - `enum Target { Stored(DbEvent), Occurrence { master: DbEvent, at: OriginalStart } }`.
  - `async fn target(&self, account, calendar, id) -> Result<Target, CalendarError>`.
  - `async fn writable(&self, account, calendar) -> Result<DbCalendar, CalendarError>`: the role must be `owner` or `writer`, otherwise `ReadOnly("You can't change events on this calendar.")`.
  - `async fn save(&self, account, calendar, api_event: ApiEvent) -> Result<EventRef, CalendarError>`: `convert::event`, then `apply_event_changes(.., None)`, emit `CalendarUpdated`, then `trigger(Some(account))`.
  - `async fn refresh_after_conflict(&self, account, calendar, id)`: `get_event`, then `save`, ignoring errors.
  - `pub struct EventRef { pub account_id: String, pub calendar_id: String, pub id: String }` (Serialize, camelCase).
- Rules for the flags:
  - `can_edit`: the calendar is writable and either the organizer is self, or `guestsCanModify` is true, or there's no organizer.
  - `can_rsvp`: a self attendee exists who isn't the organizer.
  - `can_delete`: the calendar is writable.

- [ ] **Step 1: Write the failing tests** in `service.rs` tests, seeded through `FakeCalendar` and `sync_now` like the step 1 service tests:
  - `detail_of_single_event`: attendees, Meet url, reminders and flags.
  - `detail_of_unstored_occurrence_uses_master_at_its_time`.
  - `detail_flags_for_reader_calendar_and_guest_event`.
  - `detail_unknown_id_is_not_found`.
  - In `db/calendar.rs`, `delete_overrides_from_keeps_earlier_ones`.
- [ ] **Step 2: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib calendar::service db::calendar`.** Expected: compile failure.
- [ ] **Step 3: Implement**, then run `cargo sqlx prepare` from `src-tauri/` with `DATABASE_URL=sqlite:$HOME/.cache/tmp/pheeme-sqlx/dev.sqlite`.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(calendar): event detail and write plumbing`, including `.sqlx/`.

### Task 6: Create, edit, delete, move and copy single events

**Files:**
- Modify: `src-tauri/src/calendar/writes.rs`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces `pub enum EditScope { This, Following, All }` (serde lowercase). This task treats any scope on a non-repeating event as `This`; Task 7 adds repeating events.
- Produces on `CalendarService`, each returning `Result<_, CalendarError>`:
  - `create_event(&self, account_id: &str, calendar_id: &str, edit: EventEdit, send: SendUpdates) -> EventRef`
  - `update_event(&self, account_id: &str, calendar_id: &str, event_id: &str, scope: EditScope, edit: EventEdit, send: SendUpdates) -> EventRef`
  - `delete_event(&self, account_id: &str, calendar_id: &str, event_id: &str, scope: EditScope, send: SendUpdates) -> ()`
  - `move_event(&self, account_id: &str, calendar_id: &str, event_id: &str, destination_calendar_id: &str, send: SendUpdates) -> EventRef`.
    - An instance id is `Invalid("Only a whole repeating series can move to another calendar.")`.
    - Afterwards the source rows (with overrides) are deleted from the cache and the returned event is saved in the destination.
  - `copy_event(&self, account_id: &str, calendar_id: &str, event_id: &str, to_account_id: &str, to_calendar_id: &str) -> EventRef`.
    - Duplicate is a copy to the same calendar.
    - The new event is inserted with the raw resource minus `id`, `iCalUID`, `etag`, `htmlLink`, `created`, `updated`, `creator`, `organizer`, `sequence`, `recurringEventId`, `originalStartTime`, `hangoutLink` and `conferenceData`.
    - If the original had Meet, the copy gets a fresh `createRequest`.
    - Copying an occurrence makes a single event at its times. Copying a series copies the series.
    - The copy uses `sendUpdates=none`.
- Before any call to Google:
  - The destination must pass `writable`.
  - A non-RSVP edit must pass `can_edit`, otherwise `ReadOnly("Only the organizer can change this event.")`.
  - `validate` must pass.
- The calls:
  - Create inserts with a client id.
  - Edit patches with `If-Match` of the stored etag.
  - Delete uses `If-Match`, and on success removes the row(s) from the cache.
  - A `Conflict` runs `refresh_after_conflict` first.
  - An `Unconfirmed` triggers a sync before returning.

- [ ] **Step 1: Write the failing tests** in `writes.rs`, using `FakeCalendar` with `sync_now` seeding:
  - `create_event_saves_googles_copy`: the cache row matches the fake's event, and `calendar:updated` was emitted.
  - `create_with_lost_reply_is_unconfirmed_and_shows_once`: with `lose_reply(0)`, the error is `Unconfirmed`. After the triggered sync (`tick`), the cache has the event exactly once.
  - `update_sends_if_match_and_none_by_default`.
  - `update_send_all_when_chosen`.
  - `stale_etag_refreshes_and_reports_conflict`: the fake changes the event behind Pheeme's back; the update returns `Conflict`, the cache holds the fake's newer summary, and the fake's event wasn't overwritten.
  - `rejected_edit_leaves_cache_unchanged`: 400 from the fake.
  - `offline_edit_reports_offline`.
  - `guest_cannot_edit_organizers_event`: zero writes reach the fake.
  - `reader_calendar_refuses_create`.
  - `timed_to_all_day_edit_round_trips`.
  - `delete_removes_row`.
  - `move_moves_cache_rows`.
  - `copy_strips_ids_and_requests_new_meet`.
- [ ] **Step 2: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib calendar::writes`.** Expected: compile failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS. Then run `--lib calendar`: PASS.
- [ ] **Step 5: Commit** `feat(calendar): create, edit, delete, move and copy events`.

### Task 7: Repeating events: this, this and following, all

**Files:**
- Modify: `src-tauri/src/calendar/writes.rs`

**Interfaces:**
- Consumes: `series::{split, truncate, shift_days}`, `edit::{parse_instance_id, instance_id, OriginalStart}`, `Target`.
- Behaviour for `update_event` and `delete_event` when the target is an occurrence or a stored override:

  | Scope | Edit | Delete |
  |---|---|---|
  | **This** | `patch_event` on the instance id. Use `If-Match` only for a stored override. A `recurrence` in the edit is `Invalid("Repeat can only change for the whole series.")`. | `delete_event` on the instance id. Then save a cancelled override, built by passing `{"id", "status": "cancelled", "recurringEventId", "originalStartTime"}` through `ApiEvent::try_from` and `save`. |
  | **All** | Patch the master. If the edit has `start`/`end`, shift the master by the edit's start minus the occurrence's original start: ms for timed events, days for all-day ones. Keep the edit's duration. If the day changed and the edit has no `recurrence`, also set `recurrence = shift_days(master, Δdays)`. If the edit switches between timed and all-day, put the master's first date at the edit's time. | Delete the master. |
  | **Following** | `split`. `None` means do it as **All**. Otherwise: (1) insert the new series: the master's raw stripped as in `copy_event` (but keeping `conferenceData` without `createRequest`), the occurrence's times, the edit on top, `recurrence = split.new`, with the user's `send`. (2) Patch the master to `{"recurrence": split.old}` with `If-Match`. (3) If (2) fails, delete the new series. If that delete fails too, return `Incomplete("The change was saved as a new series, but the old one couldn't be shortened, so some occurrences show twice. Delete the extra ones.")`; otherwise return the error from (2). (4) Then `delete_overrides_from(master, at_ms)` and save both events. | `truncate`. `None` means delete the master. Otherwise patch the master's `recurrence` with `If-Match`, then `delete_overrides_from`. |

- Changed occurrences after the split point are not carried over to the new series. Google drops them, and so does the website. Note this in the commit message.

- [ ] **Step 1: Write the failing tests** in `writes.rs`. Seed a weekly series of 10 (`COUNT=10`, Tuesdays 10:00 New York) with one moved occurrence in week 6:
  - `this_edit_patches_instance_only`.
  - `this_delete_hides_one_occurrence`: `service.events(..)` over the span shows 9.
  - `all_edit_new_time_shifts_master`: dragging the week-3 occurrence from 10:00 to 11:00 moves every occurrence to 11:00.
  - `all_edit_new_day_shifts_byday`: Tuesday to Wednesday gives `BYDAY=WE`.
  - `following_edit_on_count_series`: renaming from week 4 makes the fake's master `COUNT` become `UNTIL` just before week 4. The new series has `COUNT=7` and the new name, and expanding the cache over the span shows 10 occurrences in all, 3 old and 7 new.
  - `following_split_rolls_back_new_series_when_truncate_fails`: `fail_write(1, 500)`. The new series is deleted at the fake, the cache is unchanged, and the error is `api`.
  - `following_split_reports_incomplete_when_rollback_fails`: `fail_write(1, ..)` and `fail_write(2, ..)`.
  - `following_delete_truncates_and_drops_later_overrides`: the moved week-6 override is gone from the cache.
  - `following_at_first_occurrence_acts_on_all`.
- [ ] **Step 2: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib calendar::writes`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command, then repeat it with `TZ=Asia/Tokyo`.** Expected: PASS both times.
- [ ] **Step 5: Commit** `feat(calendar): edit and delete repeating events three ways`.

### Task 8: RSVP and imported invites

**Files:**
- Modify: `src-tauri/src/calendar/writes.rs`

**Interfaces:**
- Produces on `CalendarService`, each returning `Result<EventRef, CalendarError>`:
  - `respond(&self, account_id: &str, calendar_id: &str, event_id: &str, scope: EditScope, response: &str, comment: Option<String>) -> EventRef`.
    - `response` is one of `accepted`, `tentative` or `declined`.
    - `scope` is `This` or `All`; `Following` is `Invalid`.
    - `comment`: `None` keeps the existing comment, `Some("")` removes it.
  - `respond_to_invite(&self, account_id: &str, ical_uid: &str, response: &str, comment: Option<String>, import: Option<Value>) -> EventRef`. This is for Mail's invite card in step 7.
- `respond` behaviour:
  - It builds the attendee list from the target's raw resource (the master's for an unstored occurrence). The self entry (`self: true`, or the account email ignoring case) gets the new `responseStatus` and `comment`. If there is no self entry, `{email: account email, responseStatus}` is appended.
  - It patches `{"attendees": [...]}` with `sendUpdates=all` and `If-Match` when an etag is stored.
  - On `Conflict` it refreshes and tries once more against the fresh copy.
  - It needs no `can_edit`.
- `respond_to_invite` lookup order:
  1. The cached event with that `iCalUID` and no `recurring_event_id`, primary calendar first.
  2. `events_by_ical_uid` on the account's primary calendar.
  3. If `import` is `Some`, `import_event(primary, import)`, then save.
  4. Otherwise `NotFound`.

  Then it does `respond(.., All, ..)`.

- [ ] **Step 1: Write the failing tests:**
  - `rsvp_keeps_other_attendees`: three guests with mixed answers; only self changes, and `sendUpdates == all`.
  - `rsvp_adds_self_when_missing`.
  - `rsvp_this_occurrence_patches_instance`.
  - `rsvp_retries_once_after_conflict`.
  - `rsvp_following_is_invalid`.
  - `respond_to_invite_finds_cached_event_by_uid`.
  - `respond_to_invite_falls_back_to_api_lookup`.
  - `respond_to_invite_imports_when_missing`: the fake's writes show `import` then `patch`.
  - `respond_to_invite_without_import_is_not_found`.
- [ ] **Step 2: Run `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib calendar::writes`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(calendar): answer invites and import missing ones`.

### Task 9: Commands, TypeScript, preview and docs

**Files:**
- Modify: `src-tauri/src/commands/calendar.rs`. Each command is a one-line adapter wrapped in `user_action`:
  - `calendar_event_detail(account_id, calendar_id, event_id) -> EventDetailDto`, a local read with no `user_action`.
  - `create_calendar_event(account_id, calendar_id, edit: EventEdit, send_updates: SendUpdates) -> EventRef`
  - `update_calendar_event(account_id, calendar_id, event_id, scope: EditScope, edit: EventEdit, send_updates) -> EventRef`
  - `delete_calendar_event(account_id, calendar_id, event_id, scope, send_updates)`
  - `move_calendar_event(account_id, calendar_id, event_id, destination_calendar_id, send_updates) -> EventRef`
  - `copy_calendar_event(account_id, calendar_id, event_id, to_account_id, to_calendar_id) -> EventRef`
  - `respond_to_calendar_event(account_id, calendar_id, event_id, scope, response, comment: Option<String>) -> EventRef`
  - `respond_to_calendar_invite(account_id, ical_uid, response, comment: Option<String>, import: Option<Value>) -> EventRef`
- Modify: `src-tauri/src/lib.rs`: register the 8 commands.
- Modify: `src/lib/tauri.ts`:
  - Types: `TimeInput`, `AttendeeInput`, `RemindersInput`, `EventEdit`, `EditScope = "this" | "following" | "all"`, `SendUpdates = "all" | "none"`, `EventRef`, `Attendee`, `EventDetail`.
  - One wrapper per command: `getCalendarEventDetail`, `createCalendarEvent`, `updateCalendarEvent`, `deleteCalendarEvent`, `moveCalendarEvent`, `copyCalendarEvent`, `respondToCalendarEvent`, `respondToCalendarInvite`.
- Modify: `src/preview/calendar.ts` and `src/preview/calendar.test.ts`. Handlers for all 8 commands mutate the fixture list and emit `CALENDAR_EVENTS.updated`:
  - "following" behaves like "all".
  - An edit to a fixture whose organizer isn't self rejects with `{code: "read_only", message: "Only the organizer can change this event."}`.
- Modify: `CLAUDE.md`: in the `calendar/` row, writes go straight to the Calendar API with etags, repeating edits come in three scopes, and RSVP uses `sendUpdates=all`. Also add the new files.

- [ ] **Step 1: Write the failing tests** in `src/preview/calendar.test.ts`:
  - `create then edit then delete round-trips in the preview`.
  - `rsvp on the design review invite marks it accepted`.
  - `editing an organizer-owned guest event rejects with read_only`.
- [ ] **Step 2: Run `pnpm test src/preview/calendar.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement** the commands, registration, wrappers, preview handlers and the CLAUDE.md row.
- [ ] **Step 4: Run the full checks:**
  - `heavy cargo test --manifest-path src-tauri/Cargo.toml --lib`
  - `heavy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  - `cargo sqlx prepare --check` (from `src-tauri/`)
  - `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`

  Expected: all pass.
- [ ] **Step 5: Commit** `feat(calendar): event write commands, wrappers and preview`. Then tick the matching boxes on #228.
