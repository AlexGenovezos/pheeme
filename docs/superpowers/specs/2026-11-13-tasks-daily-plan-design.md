# Tasks: daily plan and booking time — design

**Parent designs:** `2026-10-31-mail-calendar-client-design.md` and `2026-11-08-calendar-design.md` (§2.6 Tasks). This adds to the existing Tasks panel. It doesn't replace anything.

## 1. Intent

Alex used TickTick and stopped because **real commitments kept getting pushed back until the pile was too big to face**. They weren't someday ideas. They were things he meant to do. He wants Pheeme's tasks to stay **native Google Tasks**, so the same tasks show on his phone and in Gmail, while doing better than Google's app at the one thing that failed him: **stopping the pile from forming**.

Why commitments pile up: a due date means "some time this day", and with no time attached a task slips one day at a time without anyone deciding to let it slip. Google's own Tasks app can give a task a time, but the public Tasks API can't read or write it (the time part of `due` is discarded), so Pheeme can't use it. A linked Calendar event is the way Pheeme can give a task a time.

Two features fix it. Alex chose both on 2026-11-13 ("Do your recommendations"):

1. **Daily plan.** Once a day, Pheeme walks through what is overdue or due today, one task at a time, and each one gets a decision. A task can no longer slip without one.
2. **Book a time.** One of those decisions is to give the task an hour on the calendar: a Google Calendar event linked to the task. A commitment gets a slot instead of a date that slides.

## 2. Goals

1. **Daily plan** (a dialog over the app):
   - It opens on its own the **first time Pheeme is in front each local day**, but **only if something is overdue or due today**. With nothing to decide, it never appears.
   - It can also be opened at any time: the `tasks.planToday` command (palette, with a key the builder picks that doesn't clash) and a **Plan today** button in the Tasks panel.
   - It covers every account's not-completed tasks that are due before today or today, in lists that aren't hidden. **Overdue tasks come first, oldest first**, then today's.
   - **One task at a time**: title, list and account, the start of its notes, and how late it is ("due 12 days ago"; worked out from the due date, nothing stored).
   - **The decisions**, each with a single key:
     - **Today**: due date becomes today. For a task already due today this means "keep".
     - **Tomorrow**.
     - **Pick a day**: date picker.
     - **Book a time**: see goal 2. The due date becomes that day.
     - **Done**: completes it.
     - **Drop**: deletes it, with Undo on a toast.
   - Each decision is written straight away through the existing tasks writes. Changes show at once and snap back with a toast if Google refuses, as the panel does today.
   - A progress line ("4 of 11") and **Stop for today**. Stopping or closing leaves the rest as they are; they come back in the next plan.
   - The end screen lists **Today**: the tasks now due today plus anything booked for today, and closes with Enter.
   - "Planned today" is remembered locally (localStorage, by local date) only to stop the dialog opening on its own again that day. It is UI state, not task data.
2. **Book a time**:
   - Opens a small picker: a day (default today) with that day's hours drawn from every shown calendar, the same idea as the invite card's mini day view. Busy blocks are shown, the user picks a start, and the length defaults to 30 minutes and can be changed (15 min to 4 h).
   - It creates an event on the **task's account's primary calendar**: the title is the task's title, and the description is the task's notes plus a line saying it was booked from Google Tasks. The link is stored in the event's `extendedProperties.private` (`pheemeTaskId`, `pheemeTaskList`). That is Google-stored, so the link survives on every device running Pheeme.
   - The task's due date is set to the event's day.
   - The event is a normal event: it can be moved, edited and deleted like any other. In Pheeme it shows a **task tick** before its title (in the grid and the popover). Ticking it completes the task, and the event stays where it is.
   - **Moving the linked event in Pheeme** to another day moves the task's due date to match. Changes made elsewhere (Google Calendar on the web or phone) aren't followed.
   - On Pheeme's calendar, a task's **dated-task chip is hidden on days where its linked event is**, so it doesn't show twice.
   - **One booking per task.** Booking a task that already has a linked event moves that event instead of making a second one. Duplicate and Copy to on a linked event drop the link from the copy. *(My call.)*
   - **Order of writes, and half failures.** The event is written first, then the task's due date. If the event write fails, nothing changes. If the due-date write fails after the event was created or moved, the event write is undone (deleted, or moved back) and the toast says booking failed, so the two never disagree. The plan moves on only once both have succeeded. The same applies to moving a linked event in Pheeme. *(My call.)*
   - **Moving the task to another list** (which can give it a new ID) updates the linked event's `pheemeTaskId`/`pheemeTaskList` to match. If that update fails, or a link points at a task that no longer exists, the event simply shows no task tick. *(My call.)*
   - **Time zone.** The booking picker shows hours in the calendar's zone, like the rest of Calendar mode (`dates.ts`), and the task's due date is the event's start day in that zone. "Today" in the plan and the panel stays in the system zone, as the panel does now. *(My call. They differ only when the computer and Google Calendar disagree about the zone.)*
   - It's also offered outside the plan, from a task's menu in the Tasks panel.
   - Accounts without calendar access see **Book a time** disabled, with the existing Allow flow.
3. **Today in the Tasks panel.** A **Today** section at the top of the panel, across all accounts and lists: tasks due today or earlier that aren't completed, with a count. Overdue ones keep the red date. If anything is overdue, the section header offers **Plan today**.

## 3. Non-goals

- Priorities, tags, due times, reminders or new repeating tasks. Google Tasks has no priorities or tags, and the public API can't read or write the times, reminders and repeats that Google's own app offers. Pheeme's rule is "one-to-one with Google or not at all", so none of these.
- Counting how often a task was pushed back. Google can't store that, and the daily plan replaces the nudge.
- Automatic scheduling (Motion-style).
- Following changes made to a linked event outside Pheeme.
- MCP tools for the plan. The existing tasks tools are enough for now.

## 4. Anti-goals

- **A plan that nags.** It must never open when there's nothing to decide, never more than once a day on its own, and must always be quick to stop.
- **Bulk "postpone all".** That is how the TickTick pile grew. The plan is deliberately one task at a time. (A first plan with a large backlog will take a while; *Drop* and *Done* keep it short. Revisit only if Alex says the first run is too heavy.)
- **Anything stored only in Pheeme** that another device would need: the task ↔ event link lives in Google (`extendedProperties`), due dates and completion in Google Tasks.

## 5. Constraints

- Google Tasks stores a date-only due date (`due`: the time part is ignored), status, title, notes, parent and position. Everything here writes only due date, status, delete, and Calendar events.
- Task writes go through `tasks/writes.rs` (straight to the Tasks API, not the outbox). Calendar writes go through `calendar/writes.rs` with `sendUpdates=none` (the event has no guests).
- `EventEdit` doesn't carry `extendedProperties` today. It needs a private-properties field for create, and the event cache needs to keep it (from `raw` or a column) so the UI knows which events are linked.
- "Today" uses the system time zone, as the Tasks panel already does (`TasksPanel.tsx`, `today()`).
- No layout shift: the plan dialog and the Today section render their full shape from the first frame, with skeletons until tasks have loaded (CLAUDE.md conventions).

## 6. Approaches considered

1. **Daily plan**: a once-a-day pass making every overdue or due-today task get a decision. Cheap, and it makes the pile impossible to ignore. Risk: becomes a chore.
2. **Book a time**: drag tasks onto calendar hours to make linked events. Gives commitments real time. The largest build, and it doesn't help clear an existing pile.
3. **Bulk move with nudges**: multi-select overdue tasks and move them all, flag tasks pushed back 3+ times. Cheapest, but bulk moving is how the TickTick pile grew, and the push count would be stored only in Pheeme.

**Picked: 1, with 2's "book a time" as one of the plan's decisions** (and in the task menu). The plan clears the pile and stops it forming again, and booking gives the task that keeps slipping a slot. The full drag-from-panel-onto-the-grid version of 2 is left for later. Option 3 is rejected for the reasons above.

## 7. Left to the builder

- The plan dialog's layout and the keys for each decision. Pick keys that read naturally (`t` today, `m` tomorrow, `d` done…) and register them through the command registry so they can be rebound.
- Whether the booking picker reuses the invite card's mini day view component or a shared extract of it.
- How the cache exposes linked events (parse `raw`, or a new column plus migration and `cargo sqlx prepare`).
- How overdue/due-today tasks are queried (extend `dated_tasks` with an open lower bound and a not-completed filter, or a new query).
- Exact wording, within the house style of the existing panel.
- Browser-preview fixtures (`src/preview/`) for the new commands, so `npm run dev` shows the plan.
