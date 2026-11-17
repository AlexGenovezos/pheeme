# Tasks: daily plan, Today, and Google's task blocks — design

**Parent designs:** `2026-10-31-mail-calendar-client-design.md` and `2026-11-08-calendar-design.md` (§2.6 Tasks). This adds to the existing Tasks panel. It doesn't replace anything.

## 1. Intent

Alex used TickTick and stopped because **real commitments kept getting pushed back until the pile was too big to face**. They weren't someday ideas. They were things he meant to do. He wants Pheeme's tasks to stay **native Google Tasks**, so the same tasks show on his phone and in Gmail, while doing better than Google's app at the one thing that failed him: **stopping the pile from forming**.

Why commitments pile up: a due date means "some time this day", and with no time attached a task slips one day at a time without anyone deciding to let it slip. Two things fix it:

1. **Daily plan.** Once a day, Pheeme walks through what is overdue or due today, one task at a time, and each one gets a decision. A task can no longer slip without one.
2. **Give a task an hour.** For a task that keeps slipping, one decision is to book it a slot on the calendar, using **Google Calendar's own task blocks** (Calendar › click an hour › Task, or drag a task from the Tasks side panel onto an hour).

Approved by Alex: the daily plan and booking on 2026-11-13 ("Do your recommendations"), and booking through Google rather than an event Pheeme makes on 2026-11-16 ("1 seems good").

## 2. What Google allows (tested 2026-11-13/14)

- **The Tasks API has no times.** `due` is date-only; the time Google's own apps give a task is dropped on write and absent on read.
- **Google's task blocks are readable.** A task block comes through the Calendar API as an event on the account's primary calendar with `eventType: "focusTime"`, the block's start and end, and a description ending in the task's link, `https://tasks.google.com/task/<code>`. The same task carries that link in its `webViewLink` (`https://tasks.google.com/task/<code>?sa=6`), so a block and its task match exactly. (Its Tasks API id was the base64 of `<code>`, but the link is what to match on.)
- **Pheeme can't create them.** The Calendar API refuses `focusTime` for personal accounts (`malformedFocusTimeEvent`: "Organizer is not an enterprise account…"). Google's web app creates blocks through a private, cookie-authenticated API (`tasks-pa.clients6.google.com/…/google.internal.tasks.v1.TasksApiService/Sync`), which a bring-your-own-client app can't and shouldn't call.

So, by Pheeme's "one-to-one with Google or not at all" rule: **booking hands off to Google Calendar, and Pheeme shows the blocks Google makes.**

## 3. Goals

1. **Daily plan** (a dialog over the app):
   - Opens on its own the **first time the app is used each local day**, but **only if something is overdue or due today**. With nothing to decide, it never appears. Never on its own in Browser preview (or the website's embedded demo of it), whose fixtures always have something due; there it opens only on request.
   - Can be opened any time: the `tasks.planToday` command (palette, "Plan today") and a **Plan today** button in the Tasks panel's Today section.
   - Covers every account's not-completed tasks due today or earlier, in lists that aren't hidden, for accounts whose tasks are readable. **Overdue tasks first, oldest first**, then today's.
   - **One task at a time**: title, list name and account (when there's more than one), the start of its notes, and how late it is ("Due 12 days ago", "Due yesterday", "Due today"), worked out from the due date.
   - **The decisions**, each a button with a single key, shown on the button and active only while the dialog is open:
     - **Today** (`t`): due date becomes today; for a task due today it's "keep".
     - **Tomorrow** (`m`).
     - **Pick a day** (`p`): a date field; Enter confirms.
     - **Book a time** (`b`): see goal 3. Sets the due date to the chosen day (default today) and hands off.
     - **Done** (`d`): completes it.
     - **Drop** (`x`): deletes it, with **Undo** on the toast (Undo re-creates it in the same list with the same title, notes and due date).
   - Each decision writes straight away through the existing tasks store (optimistic, snaps back with a toast if Google refuses), then moves to the next task.
   - A progress line ("4 of 11") and **Stop for today** (Escape too). Stopping leaves the rest as they are.
   - The end screen: "Planned" with the tasks now due today (and their task blocks' times when Google has booked them), closed with Enter.
   - "Planned on <date>" is kept in localStorage only so the dialog doesn't open on its own again that day.
2. **Today in the Tasks panel.** A **Today** section at the top of the panel, across all accounts and lists: not-completed tasks due today or earlier, overdue ones first with the red date, each a normal task row (tick, edit). The header shows the count and a **Plan today** button. The section keeps its shape while loading (skeleton rows) and says "Nothing due today" once loaded and empty.
3. **Book a time (hand-off).** Choosing it (in the plan or a task's menu in the panel):
   - sets the task's due date to the chosen day (default today; the task is then in that day's list in Google's side panel),
   - opens Google Calendar on the web at that day for the task's account (`https://calendar.google.com/calendar/u/0/r/day/YYYY/M/D?authuser=<email>`) in the default browser,
   - shows a toast: "Drag “<title>” from Tasks onto an hour in Google Calendar. Pheeme shows it here once it's booked."
4. **Google's task blocks in Pheeme.** A `focusTime` event whose description holds a `tasks.google.com/task/<code>` link that matches a cached task's `webViewLink` is that task's block:
   - On the calendar grid and in the popover it shows **as the task**: a round tick before the title (filled and the title struck through when completed). Ticking it completes or reopens the task through the tasks store. The popover hides Google's boilerplate description ("Changes made to the title… go to: <link>") and offers **Open in Google Tasks** (the link) instead of edit affordances; task blocks aren't edited or dragged in Pheeme (Google's text says edits go through Tasks).
   - The task's **dated-task chip is hidden on the day its block is**, so it doesn't show twice.
   - A block whose task isn't cached (other list hidden, not synced yet) shows as a plain event, as today.
   - Rust recognises a block when events are read (`CalendarEvent.taskLink`, and `canEdit` is false for it); the frontend matches the link against the tasks it already has for those days.

## 4. Non-goals

- Creating task blocks or any event from Pheeme (Google refuses it for personal accounts; see §2).
- Priorities, tags, due times, reminders, or new repeating tasks (Google Tasks' API can't store them).
- Counting how often a task was pushed back.
- Automatic scheduling.
- MCP tools for the plan.

## 5. Anti-goals

- **A plan that nags**: never opens with nothing to decide, never more than once a day on its own, always one key to stop.
- **Bulk "postpone all"**: that's how the TickTick pile grew. One task at a time; Drop and Done keep a big first run short.
- **Anything stored only in Pheeme** that another device would need. The only local state is "planned on <date>".

## 6. Constraints

- Task writes go through `tasksStore` → `tasks/writes.rs` (straight to the Tasks API, not the outbox).
- "Today" uses the system time zone, as the Tasks panel already does.
- No layout shift: the dialog and the Today section have their full shape from the first frame.
- Browser preview (`src/preview/tasks.ts`, `calendar.ts`) answers the new command and shows a task block, so `npm run dev` shows everything.

## 7. Approaches considered (for booking)

1. **Hand off to Google Calendar (picked).** Google makes its real task block; Pheeme reads it and shows it as the task. Native everywhere; costs a trip to the browser for each booking.
2. **A linked event Pheeme creates.** Stays in the app, but every other device shows a plain event, apart from the task. Alex said it's also fine; it can be added later if the trip to the browser grates.
3. **Bulk move with nudges.** Rejected: bulk moving grew the pile, and a push count would be Pheeme-only.

## 8. Left to the builder

- Layout of the dialog and Today section within the panel's house style.
- How overdue tasks are queried (a new `db::tasks` query with an upper bound and a not-completed filter).
- Where the task-block match lives in `calendar/service.rs` and how it's batched.
