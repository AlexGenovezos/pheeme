# Calendar mode — design

**Parent design:** `2026-10-31-mail-calendar-client-design.md` §8 (Calendar mode, post-v1). This document widens §8 in two ways: Google Tasks is added, and creating an event from any email is added. Where the two documents disagree, this one wins for calendar work.

## 1. Intent

Alex wants Google Calendar inside Pheeme so he stops opening the website: "month, week, day views. I feel like it works fine, but having it all in my own native app would be better." The bar is **parity with calendar.google.com**, not a redesign. Everything he does on the website (viewing, creating, editing and deleting events, answering invites, tasks) should work in Pheeme, and changes should show up in both places.

Mail is the reason this belongs in Pheeme rather than in a separate calendar app:

- **Invites.** When an email is an invitation, Alex wants to see **what else is happening around that time** before he answers, then accept from the email, then open the calendar on that day to see the rest of it.
- **Any email can become an event.** Pheeme makes a new event from the email, with the details already filled in.

Scope: Alex said "we should go for all of it". Nothing on this list is deferred. It is built in steps (§9), but it ships as one feature.

Approved shape: the mockup shown on 2026-11-08 ("Invite flow: Mail card → Calendar day"). In Mail, the invite card has Yes, Maybe and No, a mini day view of the hours around the invite with clashes flagged, and "Open … in Calendar". Below that is Calendar mode's week view with the email pinned on the left, the unanswered invite as a dashed block among real events, and dated tasks in a strip above the hours. Alex: "yea that looks good". He also approved the playback covering tasks, invites, all accounts and creating an event from an email ("all that seems great").

## 2. Goals

1. **Calendar mode.** A top-level mode next to Mail, switched with one shortcut or the Mail/Calendar switch in the title bar. Mode and view are remembered across launches.
2. **Views:** Day, Week and Month, as on the website. Prev/next and Today, a mini month in the sidebar for jumping to any date, and the current-time line. All-day and multi-day events sit in a band above the hours.
3. **All accounts together.** Every connected account's calendars appear in one view. The sidebar lists each account's calendars (own, other people's calendars added to it, holidays and other subscribed calendars) with a checkbox to show or hide each one and Google's colour for it.
4. **Events, at website parity:**
   - **Create:** click or drag on the grid, `c`, or a **Create** button. A quick popover (title, time, calendar) has **More options** for the full editor.
   - **Full editor:** title; all-day; start and end with time zones; repeat (the website's presets plus Custom: every N days/weeks/months/years, weekdays, ends never/on a date/after N times); guests, with suggestions from the existing contact service, guest permissions, and on save "send updates to guests?" as on the website; Google Meet (add/remove); location; description; calendar; event colour; reminders (notification and email, minutes/hours/days/weeks before); busy/free; visibility.
   - **Edit:** the popover and editor; drag to move, drag the bottom edge to resize, and drag across days in week view.
   - **Delete.**
   - **Repeating events:** edits and deletes ask "This event / This and following events / All events", like the website.
   - **Duplicate**, and **copy to another calendar** where Google allows it.
5. **Invites and RSVP:** Yes, Maybe or No, with an optional note to the organizer, from the event popover, from the pinned email and from the invite card in Mail. **Propose a new time** is a builder's call (§6.12).
6. **Tasks, both kinds Alex asked for:**
   - **Tasks with a due date on the calendar**, in the all-day band of their day (Google Tasks stores dates only, no times). Ticking one off crosses it out in place.
   - **A Tasks panel**, a right-hand side panel in Calendar mode that can also be opened from Mail. It lists all task lists across accounts. You can add, edit (title, details, due date, repeat if the API allows it), complete, delete, reorder and indent tasks (subtasks), move a task to another list, and create, rename and delete lists.
7. **Invites in Mail.** Any message with a calendar invite (a `text/calendar` part or an `.ics` attachment) shows the **invite card** at the top of the message:
   - The title, when, where (a Meet link becomes a Join button), the organizer, and how many guests and how they have answered.
   - **Yes, Maybe, No** buttons, plus **More options** (with a note, or reply only to this event in a series).
   - A **mini day view** of the hours around the invite, built from all of Alex's visible calendars. The invite is a dashed block, and an overlap is flagged in words: "Overlaps 1:1 Alex (2:30)".
   - **Open … in Calendar**, which switches to Calendar mode on that day (keeping the current view type) with the email pinned.
   - Updated and cancelled invites say so ("This event was cancelled", "Time changed to …"), and the card always shows the event's current state from the calendar, not just what the email said.
8. **Pinned email.** While in Calendar mode, the email you came from stays pinned in a narrow left column: its subject, sender, the start of its text and the RSVP buttons if it's an invite. It can be scrolled, closed, or clicked to go back to it in Mail.
9. **Create an event from any email.** Available as a button and menu item in the conversation view, a command palette entry and a shortcut. It switches to Calendar mode with the email pinned and a new event already filled in:
   - **Title:** the subject, without `Re:`/`Fwd:`.
   - **Guests:** everyone on the thread except you.
   - **Description:** a link back to the conversation in Gmail, plus the start of the email.
   - **Time:** if the email mentions a date or time ("Thursday at 3", "Nov 12 2–3pm"), the event starts there and the grid jumps to it. Otherwise the event is placed but not saved, and you click or drag the slot you want.
   - It is saved to the calendar of the account that received the email.
10. **Reminders.** Event reminders of the "notification" type pop up as desktop notifications through the existing notification system, honouring Settings › Notifications (schedule, Focus). Clicking one opens the event.
11. **Two-way sync.** Changes made on the website or a phone show up in Pheeme within about a minute while it's open (sooner when Calendar mode is in front), and Pheeme's changes show up there.
12. **Keyboard first, using the website's shortcuts:** `d`/`w`/`m` views, `t` today, `j`/`k` (and `n`/`p`) next/previous period, `c` create, `e` edit, `Backspace`/`Delete` delete, `/` search, `g` go to date. Mode switch and the commands go through the command registry, so they can be rebound. Every action can be reached without a mouse.
13. **Same quality bar as Mail:** instant from the local cache, no layout shift while data loads (CLAUDE.md), working offline for reading, and light/dark/custom themes using design tokens.

## 3. Non-goals

- Creating or deleting calendars, sharing settings, or subscribing to a calendar by URL. Those stay on the website.
- Year and Schedule views, and "4 days"/custom views. Alex named day, week and month.
- Appointment schedules / booking pages, working-location and out-of-office event types beyond showing them read-only, focus time auto-decline, birthdays editing.
- Non-Google calendars (CalDAV, Outlook, iCloud).
- Event search across all time (`/` searches cached events only, see §6.10).

## 4. Anti-goals

These would make this a failure even if every feature technically works:

- **An edit that silently doesn't stick.** If Google rejects a change, or you're offline, the event must snap back and say why. It must never sit looking saved while never reaching Google.
- **Guests emailed unexpectedly.** Pheeme sends updates to guests only when you choose that, matching the website's prompt.
- **A repeating series mangled.** Getting "this and following" wrong (duplicated or lost occurrences) is worse than not offering it.
- **Mail getting slower.** Calendar sync must not hold up mail sync or the Gmail quota that user actions need.
- **Asking for calendar access before the calendar is opened.** The setup guide promises not to.

## 5. Constraints

- **Stack and patterns as Mail.** A Rust service module (`calendar/`, Tauri-free, like `labels.rs`/`contacts.rs`), thin `commands/calendar.rs`, typed wrappers in `src/lib/tauri.ts`, SQLite via `sqlx::query_as!` with `.sqlx` regenerated, Zustand stores, browser-preview fixtures in `src/preview/` so `npm run dev` shows a working calendar.
- **BYOC.** The user's Google Cloud project must have the **Google Calendar API** (the setup guide already asks for it) and the **Google Tasks API** (new; add a setup step and mirror it in `docs/google-cloud-setup.md`) turned on.
- **Access is requested when Calendar mode first opens.** That's an incremental OAuth consent for the calendar and tasks scopes, per account, with `include_granted_scopes=true` and `login_hint`. Mail keeps working if it's declined. Use the narrowest scopes that cover §2: expected `calendar.events`, `calendar.calendarlist.readonly`, `calendar.settings.readonly` and `tasks`. If free/busy for guests needs one more, add it. Never request full `calendar` unless something in §2 can't be done without it.
- **Quota.** Calendar and Tasks have their own API quotas, separate from Gmail's, but user-initiated calls still go through `gmail::user_action`'s priority path so they're never queued behind background work.
- **Gmail invites and the Calendar API.** Google normally adds an invite to the recipient's calendar on its own, and the event is found through `iCalUID`. External invites that aren't on the calendar are imported (`events.import`) when answered.

## 6. Builder's calls (mine, made while writing this; Alex can override)

1. **Edits go straight to the Calendar and Tasks APIs, not the mail outbox**, the same as label changes (design `2026-11-06-labels-design.md` §6.1). The UI updates optimistically, then on success the event Google returns is written to the cache. On failure it rolls back and shows the error (anti-goal 1). Offline: reading works, and editing shows "You're offline; changes can't be saved" instead of queueing them.
2. **Sync uses `syncToken` per calendar with `singleEvents=false`**, so the cache holds series and their changed occurrences. Occurrences are expanded locally for the range being shown (a Rust RRULE implementation, e.g. the `rrule` crate, handling `EXDATE`, `RDATE` and changed or cancelled occurrences via `recurringEventId`/`originalStartTime`). Reason: the Calendar API can't combine `syncToken` with a time window, and this keeps every view instant and offline. **Fallback** if local expansion proves wrong on real data: a windowed `singleEvents=true` fetch around the visible range, cached. `410 Gone` means a full re-sync of that calendar.
3. **Sync cadence:** at launch, every 60 s while the app runs, every 15 s while Calendar mode is in front, and immediately after any of our own writes. The calendar list and settings sync every 15 min. Calendar push notifications need a public webhook, so they aren't used.
4. **Tasks sync** polls `tasks.list` with `updatedMin`, `showCompleted`, `showDeleted` and `showHidden` (the Tasks API has no sync token) on the same cadence, with a full re-list every 6 h.
5. **Time zones:** times are stored in UTC milliseconds plus the event's IANA zone, and shown in the user's Calendar time zone (`settings.get timezone`, falling back to the OS zone). All-day events are stored as dates and never shifted. The week starts on the Calendar `weekStart` setting.
6. **Colours:** the calendar's `backgroundColor`/`foregroundColor` from `calendarList`, and the event `colorId` mapped through `colors.get`. These go through the same contrast checks as label chips in every theme. Where calendar names collide across accounts, a small account dot tells them apart.
7. **Invite detection:** the `text/calendar` part or `.ics` attachment is fetched when the message opens (they're small) and parsed in Rust for `METHOD`, `UID`, `DTSTART`/`DTEND`/`RRULE`, `SEQUENCE` and `RECURRENCE-ID`. The card then reads the live event from the cache by `iCalUID` (falling back to `events.list?iCalUID=`). The answer patches `attendees[self].responseStatus` with `sendUpdates=all`, as the website does.
8. **Parsing a date from an email** uses `chrono-node` in the frontend on the subject plus the first ~2,000 characters of plain text, relative to the email's date. The first match with a time wins, otherwise the first date. If there's no match, there's no time.
9. **Meet links** come from `conferenceData.createRequest` (`conferenceDataVersion=1`).
10. **Search in Calendar** (`/`) filters cached events (title, location, description, guests) from a year back to two years ahead, and jumps to the one picked.
11. **Reminders** fire from the local cache: a scheduler in Rust looks ahead 24 h, re-plans after each sync, and catches up on a reminder missed by less than 5 minutes (after sleep). Notification reminders only, because email reminders are Google's job.
12. **Propose a new time** is skipped, because the API doesn't expose it cleanly. Use **No** plus a note.
13. **Storage:** new tables `calendars` (per account: id, summary, colours, access role, selected/hidden, default reminders, sync token), `events` (account, calendar, event id, iCalUID, series id, original start, status, start/end UTC ms or dates, zone, summary, location, description, organizer, attendees JSON, self response, conference JSON, colour, reminders JSON, transparency, visibility, recurrence JSON, `etag`, `updated`, the raw resource JSON for fields we don't model), `task_lists`, `tasks` (list, id, parent, position, title, notes, due date, status, completed, updated, raw JSON) and `calendar_sync` state. Writes use `If-Match` with the `etag` so a stale edit can't overwrite a newer one; a 412 refetches and asks again.
14. **First open per account:** a short screen like Settings › Contacts. It says the Calendar API, and the Tasks API, need to be on in your Google Cloud project, with buttons that open each one, and then **Allow calendar access**, which starts the incremental consent. Accounts that haven't allowed it yet are listed in the sidebar with an **Allow** button, so one declined account doesn't block the others. If the Tasks API is off, Calendar still works and the Tasks panel shows how to turn it on.

## 7. UI outline

- **Title bar:** a Mail | Calendar switch (shortcut `g c` / `g i` style chords, final keys chosen to avoid clashes with existing Mail chords), and Calendar's ‹ › Today, the date range title, and the Day/Week/Month switch.
- **Calendar sidebar** (in place of the mail sidebar, same width and collapse behaviour): **Create**, the mini month, then a group per account with its calendars (checkboxes and colours), then task lists (checkboxes control which lists' dated tasks show on the grid).
- **Grid:** week and day have a time gutter, hour lines and the current-time line. Overlapping events share the width the way the website does. Month has day cells with "+N more", and clicking a day opens it in Day view. Declined events are struck through and dimmed, and unanswered invites are dashed, as on the website.
- **Event popover** (click): the details, Yes/Maybe/No, Join Meet, edit/delete/duplicate, and the guest list with each guest's answer.
- **Editor:** a dialog over the app in the Settings dialog style, not a separate page.
- **Tasks panel:** a toggle on the right edge in both modes.
- **Invite card and Create event from this email** in Mail's conversation view.

## 8. Testing

- **Rust:** a `CalendarApi`/`TasksApi` trait with in-memory fakes, like `sync/fake.rs`, so sync, the 410 resync, expansion of repeating events (EXDATE, changed and cancelled occurrences, this-and-following splits, time zone/DST edges), etag conflicts and the reminder scheduler are tested offline. ICS parsing is tested against recorded fixtures from Google, Outlook and Apple invites.
- **Frontend:** Vitest for layout (overlaps, all-day bands, month overflow), date parsing from emails, editor validation and stores. The browser preview (`npm run dev`) has realistic fixtures, including an invite email and a clash.
- **Real account check** before calling it done: create/edit/delete on both sides, a repeating series edited all three ways, an invite answered from Mail and shown as answered on the website, and tasks done on both sides.

## 9. Build order (for the plan)

One feature, built as a stack of PRs. Each ends with the app working and tests passing:

1. **Calendar backend: read.** Scopes and incremental consent, the API client, schema, sync, local expansion of repeating events, read commands, fakes and tests.
2. **Calendar backend: write.** Create/edit/delete/move, the three ways of editing a repeating event, RSVP, import, Meet, etags.
3. **Tasks backend:** client, schema, sync, write commands.
4. **Calendar UI: views.** The mode switch, sidebar, Day/Week/Month, popover (read and RSVP), first-open screen, preview fixtures.
5. **Calendar UI: editing.** The quick-create popover, full editor, drag to create, move and resize, repeating-event prompts, guest prompts, search.
6. **Tasks UI:** the panel and dated tasks on the grid.
7. **Mail integration:** the invite card with mini day view, Open in Calendar with the pinned email, Create event from email.
8. **Reminders, setup guide and docs:** reminder notifications, the Tasks API onboarding step plus `docs/google-cloud-setup.md`, CLAUDE.md/README updates and release notes.
