# Tasks daily plan, Today and task blocks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A once-a-day plan that makes every overdue or due-today Google Task get a decision, a Today section in the Tasks panel, booking a time by handing off to Google Calendar, and Google's own task blocks shown as their tasks on Pheeme's calendar.

**Architecture:** Rust adds one cache query (open tasks due through a date) and a `taskLink` on calendar events (Google's task blocks are `focusTime` events whose description links the task). Everything else is frontend: pure rules in `src/tasks/plan.ts`, a `due` slice in `tasksStore`, a `TodaySection` in the panel, a `PlanToday` dialog, and task-block rendering in the calendar.

**Tech Stack:** Rust (sqlx, serde), React 18 + Zustand, Vitest, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-11-13-tasks-daily-plan-design.md`

## Global Constraints

- Writes only through the existing `tasksStore` actions (`editTask`, `setCompleted`, `deleteTask`, `addTask`); nothing goes to the outbox; nothing new is stored except localStorage key `pheeme.tasks.planned` = `YYYY-MM-DD`.
- "Today" is the system zone date, as `TasksPanel.tsx` computes it (`dateOf(Date.now(), systemZone())`).
- No layout shift (CLAUDE.md): full shape from the first frame, skeletons until loaded; "empty" messages only after the load finished (`null` ≠ `[]`).
- Label buttons with `useKeybinding(commandId)`, never literal keys. New commands register through `useCommands`.
- Every new Tauri command: fn in `commands/tasks.rs`, registered in `lib.rs`, typed wrapper in `src/lib/tauri.ts`, and a handler in `src/preview/tasks.ts`.
- After any query change: `cargo sqlx prepare` from `src-tauri/` and commit `.sqlx/`.
- CI gates: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test`, `npm run deadcode`, `npm run dupes`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (all through the `pnpm`/`heavy` slots — wrap direct cargo calls in `heavy`).
- Copy (exact): button labels `Today`, `Tomorrow`, `Pick a day`, `Book a time`, `Done`, `Drop`, `Stop for today`, `Plan today`, `Open in Google Tasks`; empty state `Nothing due today`; book toast title `Book it in Google Calendar`, description `Drag “<title>” from Tasks onto an hour. Pheeme shows it here once it's booked.`; drop toast `Task dropped` with action `Undo`.

## Review Focus

1. **Task due today but already completed** — never in the plan or Today (test in Task 1 and Task 3).
2. **Task in a hidden list or an account whose tasks access isn't `on`** — not planned (Task 1 test covers hidden lists; access is implicit because such accounts have no cached tasks).
3. **A task block whose task isn't cached** (another account, hidden list) — draws as a plain event, no tick, no crash (Task 6 test).
4. **Google refuses a decision mid-plan** (offline) — the store snaps back with its toast; the plan still advances and the task reappears next time (Task 5 test: rejected `updateTask` still advances).
5. **Midnight passes with Pheeme open** — auto-open checks the date at each window focus, not just at launch (Task 5 test with a mocked date change).

---

### Task 1: Rust — open tasks due through a date

**Files:**
- Modify: `src-tauri/src/db/tasks.rs` (new query beside `dated_tasks`), `src-tauri/src/tasks/service.rs` (method beside `dated_tasks`), `src-tauri/src/commands/tasks.rs`, `src-tauri/src/lib.rs` (register), `.sqlx/`

**Interfaces:**
- Produces: `db::tasks::open_due_through(ex, through_date: &str) -> Result<Vec<DbTask>>` — not completed (`status != 'completed'`), `due_date <= through_date`, list not hidden, task not hidden; ordered `due_date, account_id, l.sort_order, t.position, t.id`.
- Produces: `TasksService::due_through(&self, through_date: &str) -> Result<Vec<TaskDto>, MailError>` (map with `TaskDto::from`, no outline).
- Produces: Tauri command `tasks_due_through(through_date: String) -> Vec<TaskDto>` (JS: `{ throughDate }`).

- [ ] **Step 1: Failing db test** `open_due_through_keeps_open_tasks_due_by_the_date` in `db/tasks.rs` tests: seed (reuse the module's seeding helpers) tasks due `2026-11-10` (open), `2026-11-16` (open), `2026-11-16` (completed), `2026-11-17` (open), undated (open), and `2026-11-12` (open) in a hidden list. Assert `open_due_through(&pool, "2026-11-16")` returns exactly the ids of the `11-10` then `11-16` open tasks, in that order.
- [ ] **Step 2:** `heavy cargo test --manifest-path src-tauri/Cargo.toml open_due_through` → fails (function missing).
- [ ] **Step 3:** Implement the query with `sqlx::query_as!` (same columns as `dated_tasks`), the service method, and the command; register in `lib.rs` next to `commands::tasks::dated_tasks`. Run `cargo sqlx prepare` (see CLAUDE.md).
- [ ] **Step 4:** test passes; `heavy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` clean.
- [ ] **Step 5:** Commit `feat(tasks): read every open task due through a date`.

### Task 2: Rust — `taskLink` on calendar events

**Files:**
- Create: `src-tauri/src/calendar/task_block.rs` (declare in `calendar/mod.rs`)
- Modify: `src-tauri/src/calendar/service.rs` (`CalendarEventDto`, `base_dto`, the `editable`/`can_edit` sites at ~352, ~497, ~529)

**Interfaces:**
- Produces: `pub fn task_link(raw: &str, description: Option<&str>) -> Option<String>` — `Some("https://tasks.google.com/task/<code>")` only when the description contains `https://tasks.google.com/task/<code>` (`<code>` = `[A-Za-z0-9_-]+`, stop at anything else) **and** the raw resource's `eventType` is `"focusTime"`. Check the description first (cheap) and only then parse `raw`.
- Produces: `CalendarEventDto.task_link: Option<String>` (JSON `taskLink`), filled in `base_dto` from `e.raw`/`e.description`. A task block is never editable: wherever `can_edit` is computed for an event (list and detail), AND it with `task_link.is_none()`.

- [ ] **Step 1: Failing tests** in `task_block.rs`: `focus_time_with_task_link_is_a_block` (raw `{"eventType":"focusTime"}`, description `Changes made to the title, description, or attachments will not be saved. To make edits, please go to: https://tasks.google.com/task/m6D4f5_SATtUpxoQ` → `Some("https://tasks.google.com/task/m6D4f5_SATtUpxoQ")`); `default_event_with_link_is_not` (`eventType` `default` → `None`); `focus_time_without_link_is_not`; `link_stops_at_query_or_space` (`…/task/abc_D-9?sa=6 more` → `…/task/abc_D-9`).
- [ ] **Step 2:** run → fail.
- [ ] **Step 3:** implement; add the DTO field and the `can_edit` rule. Add one service test in `calendar/service.rs` tests: an event cached with that raw/description comes back from the range read with `task_link` set and `can_edit == false`.
- [ ] **Step 4:** `heavy cargo test --manifest-path src-tauri/Cargo.toml task_block` and the service test pass; clippy clean.
- [ ] **Step 5:** Commit `feat(calendar): mark Google's task blocks with their task's link`.

### Task 3: Frontend — IPC types, preview fixtures, plan rules

**Files:**
- Modify: `src/lib/tauri.ts` (wrapper + `CalendarEvent.taskLink`), `src/preview/tasks.ts` (+ test), `src/preview/calendar.ts` (one task block fixture)
- Create: `src/tasks/plan.ts`, `src/tasks/plan.test.ts`

**Interfaces:**
- Produces (tauri.ts): `getTasksDueThrough(throughDate: string) => invoke<Task[]>("tasks_due_through", { throughDate })`; `CalendarEvent.taskLink: string | null` (doc: "Google's task block for this task (`https://tasks.google.com/task/<code>`); not editable here").
- Produces (`plan.ts`):
  - `planQueue(tasks: Task[], today: string): Task[]` — open, not hidden, `due <= today`; overdue first oldest first, then today's; stable otherwise.
  - `lateness(due: string, today: string): string` — `"Due today"`, `"Due yesterday"`, `"Due N days ago"`.
  - `PLANNED_KEY = "pheeme.tasks.planned"`; `readPlanned(store?): string | null`; `writePlanned(date, store?)`; `shouldAutoOpen(planned: string | null, today: string, queue: Task[]): boolean` (true only when `planned !== today` and `queue.length > 0`).
  - `bookingUrl(email: string, date: string): string` → `https://calendar.google.com/calendar/u/0/r/day/2026/11/16?authuser=<encodeURIComponent(email)>` (month/day without leading zeros).
  - `taskForBlock(link: string, tasks: Task[]): Task | undefined` — the task whose `webViewLink` equals `link` or starts with `link + "?"`.
  - `withoutBooked(tasks: Task[], events: CalendarEvent[]): Task[]` — drops a task when some event has a `taskLink` matching it (by `taskForBlock`) whose start day (`event.start.date ?? dateOf(event.start.ms, zone)`) equals `task.due`; take the zone as a third param `zone: string`.
- Preview: `tasks_due_through` handler over the same fixture tasks as `dated_tasks`; fixtures must include at least one overdue open task, one due today, and one completed due today. `calendar.ts`: one `focusTime`-style fixture event today 15:00–16:00 with `taskLink` equal to a fixture task's `webViewLink` (give that task a `webViewLink`), `canEdit: false`.

- [ ] **Step 1: Failing tests** in `plan.test.ts`: `planQueue` order and filtering (completed due today excluded, future excluded, hidden excluded, `2026-11-10` before `2026-11-14` before today's); `lateness` three strings; `shouldAutoOpen` (planned today → false, empty queue → false, else true); `bookingUrl("a+b@x.com","2026-11-06")` → `…/r/day/2026/11/6?authuser=a%2Bb%40x.com`; `taskForBlock` matches `…/task/abc?sa=6` but not `…/task/abcd`; `withoutBooked` drops only on the block's day. In `preview/tasks.test.ts`: `tasks_due_through({ throughDate })` returns only open tasks due by then.
- [ ] **Step 2:** `npm run test -- src/tasks/plan.test.ts src/preview/tasks.test.ts` → fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** tests pass; `npm run typecheck` clean.
- [ ] **Step 5:** Commit `feat(tasks): plan rules, due-through wrapper and preview fixtures`.

### Task 4: Frontend — `due` in the store and the Today section

**Files:**
- Modify: `src/tasks/tasksStore.ts`, `src/tasks/TasksPanel.tsx`, `src/tasks/tasks.css`
- Create: `src/tasks/TodaySection.tsx`; tests in `src/tasks/TasksPanel.test.tsx`

**Interfaces:**
- Produces (store): `due: Task[] | null` (`null` until first load), `dueError: string | null`, `loadDue(): Promise<void>` (reads `getTasksDueThrough(today)` with a ticket like `loadDated`, applies `pending` changes with a filter that drops tasks no longer open/due), and `reload` / the `tasks:updated` and `tasks:access` listeners also call `loadDue`. Optimistic `PendingChange` gains `due(tasks)` applied like `dated` (patches apply, deletes filter).
- Produces: `<TodaySection />` at the top of `.tasks-panel__scroll`: heading "Today" with count, a `Plan today` button (`data-command="tasks.planToday"`, shortcut from `useKeybinding`), rows using the existing `TaskRow` (overdue rows keep the red date class), 2 skeleton rows while `due === null`, `Nothing due today` once loaded and empty. Each row's menu gains `Book a time` (Task 5's `bookTask`).

- [ ] **Step 1: Failing tests** (TasksPanel.test.tsx, mocking `getTasksDueThrough` the way the file mocks other commands): Today shows overdue then today's tasks; shows skeleton rows (same count of `.task-row` elements) before load; `Nothing due today` only after an empty load; ticking a Today row calls `setTaskCompleted` and removes it from Today.
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** pass + typecheck + lint.
- [ ] **Step 5:** Commit `feat(tasks): a Today section at the top of the Tasks panel`.

### Task 5: Frontend — the Plan today dialog

**Files:**
- Create: `src/tasks/PlanToday.tsx`, `src/tasks/planStore.ts`, `src/tasks/PlanToday.test.tsx`; styles in `src/tasks/tasks.css`
- Modify: `src/tasks/TasksPanel.tsx` (mount `<PlanTodayHost />` inside `TasksPanelHost`, which is always mounted)

**Interfaces:**
- Consumes: `planQueue`, `lateness`, `readPlanned`/`writePlanned`/`shouldAutoOpen`, `bookingUrl` (Task 3); `due`, `loadDue`, `editTask`, `setCompleted`, `deleteTask`, `addTask` (Task 4 / existing).
- Produces: `usePlanStore` with `open: boolean`, `queue: Task[]` (snapshot taken at open; decisions don't reorder it), `index: number`, `openPlan()`, `close()`, `next()`. Command `tasks.planToday` ("Plan today", group "Tasks", global). `bookTask(task: Task, date: string): Promise<void>` exported from `PlanToday.tsx` (or `plan.ts` if it has no React): `editTask(task, { due: date })`, then `openExternal(bookingUrl(email, date))` (email from `useTasksStore.getState().accounts`), then the book toast.
- Decision keys as commands active only while open (ids `plan.today` `t`, `plan.tomorrow` `m`, `plan.pickDay` `p`, `plan.book` `b`, `plan.done` `d`, `plan.drop` `x`); Escape = Stop for today. Pick a day and Book a time show a `DateField` (default today for Book, tomorrow for Pick) confirmed with Enter.
- Drop: `deleteTask(task)` then toast `Task dropped` with `Undo` → `addTask(task.accountId, task.listId, { title, notes, due })`.
- Opening (manual or auto) writes `writePlanned(today)`. Auto-open: on mount and on each window `focus`, when `due` is loaded, `shouldAutoOpen(readPlanned(), today, planQueue(due, today))` → `openPlan()`.
- End screen: "Planned" + the tasks now due today (from the store's `due`), Enter closes.
- Every dialog element (title line, meta line, notes line, progress, six buttons) renders from the first frame.

- [ ] **Step 1: Failing tests:** opens on its own when something is overdue and not planned today, not when `pheeme.tasks.planned` is today, not when nothing is due; `t` sets due to today and advances; `d` completes; `x` deletes and Undo re-adds with the same title/notes/due; a rejected `updateTask` still advances (store shows its toast); `b` with the date field confirmed calls `updateTask` with the date and opens `bookingUrl`; Escape closes and the rest stay due; a window `focus` after the date changes (mock `Date.now`) re-opens.
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** pass + typecheck + lint + format.
- [ ] **Step 5:** Commit `feat(tasks): plan today, one overdue task at a time`.

### Task 6: Frontend — Google's task blocks on the calendar

**Files:**
- Modify: `src/calendar/EventBlock.tsx`, `src/calendar/EventPopover.tsx`, `src/calendar/TimeGrid.tsx`, `src/calendar/MonthGrid.tsx`, `src/calendar/calendar.css`
- Test: `src/calendar/CalendarScreen.test.tsx` (or a new `src/tasks/TaskBlocks.test.tsx`)

**Interfaces:**
- Consumes: `CalendarEvent.taskLink`, `taskForBlock`, `withoutBooked` (Task 3); dated tasks from `useDatedTasks`.
- Produces: in EventBlock, an event whose `taskLink` matches a dated task draws a round tick (reuse `.task-check` from tasks.css) before its title; ticking calls `useTasksStore.getState().setCompleted(task, !task.completed)` and stops propagation; completed → title struck through. The popover for such an event: no description boilerplate (hide the description entirely for a matched block), an `Open in Google Tasks` button (`openExternal(event.taskLink)`), and a `Mark completed` / `Mark not done` button. TimeGrid/MonthGrid pass dated tasks through `withoutBooked(tasks, events, zone)` before `layoutTasks`.
- An unmatched block (no cached task) renders exactly as today.

- [ ] **Step 1: Failing tests:** a fixture block event with a matching dated task shows the tick and hides that task's chip on that day; ticking calls `setTaskCompleted`; the popover shows `Open in Google Tasks` and not the boilerplate; an unmatched block shows no tick.
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** pass + typecheck + lint.
- [ ] **Step 5:** Commit `feat(calendar): show Google's task blocks as their tasks`.

### Task 7: Docs and whole-branch checks

**Files:** `CLAUDE.md` (Tasks UI paragraph: Today section, Plan today, task blocks; `tasks/` row: `due_through`; calendar row: `task_block.rs`), `src/settings` keyboard list if commands appear there automatically (verify only).

- [ ] Run every CI gate from Global Constraints; fix anything.
- [ ] Browser preview proof: `npm run dev`, open the app, screenshot the Today section, the plan dialog (auto-opened), and the calendar day with the task block.
- [ ] Commit `docs: tasks plan, Today and task blocks`.
