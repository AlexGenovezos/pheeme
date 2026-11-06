# Pheeme UI scorecard — rubric v1

**Baseline: 78/100.** Assessed 2026-11-04 (America/Chicago), Pheeme 0.10.0, HEAD `a564a90`, including the local uncommitted app changes present during this audit.

The app feels calm, coherent, and credible as a desktop mail utility. Its biggest weaknesses are small low-contrast text and important actions that depend on icon recognition or hover. The reader has a clear subject/message hierarchy; settings and compose share a consistent visual system.

## Scope and repeatable procedure

This grades the desktop application in `src/`, not the marketing site. It is a manual browser-and-source audit using the browser fixture backend from `npm run dev`. Real Gmail delivery, Google OAuth, native menus, OS vibrancy, and screen-reader behavior were not tested. A source-backed pass describes the UI implementation, not a verified native integration.

1. Start the current checkout with `npm run dev -- --host 0.0.0.0`. Use a fresh browser profile at 100% zoom, default pane widths, two fixture accounts, and both light/dark themes.
2. Inspect the initial shell; Primary; All Inboxes; the incoming “Icon sketches for the dock” conversation; and a new message. Use 1280×800 and 900×600 CSS-pixel viewports, the latter matching the configured native minimum. Mobile is outside this rubric.
3. Move the pointer off the list when checking initial action discoverability. Inspect incoming mail under All Inboxes when checking account context.
4. In fixtures only: archive Mira’s conversation and Undo; search for `zzzz-no-match-ui-audit` and clear; attempt to send to `invalid-address`; then edit a valid scratch draft and wait for “Draft saved.” Discard the scratch draft.
5. Exercise Ctrl/Cmd+K, Escape, list ArrowDown/Enter/X, and settings Tab/Shift+Tab/Escape. Inspect semantic labels and computed focus styles.
6. Open `/?accounts=0` in a fresh profile. Inspect welcome, project, and credential screens and the setup rail. Inspect source for persistence, validation, and recoverable load-error UI as marked below.
7. Run `npm run lint:tokens`. Measure text contrast from the active theme colors using WCAG relative luminance, with no rounding before comparing against 4.5.

## Scoring contract

There are **8 categories, 5 binary checks each, 100 total points**. Every check in a category is worth `category weight / 5` points. Pass earns all of its points; fail earns zero. No partial credit, bonus points, or denominator changes. An unverified item earns zero and must be marked unverified; source inspection counts as verification only where the check/evidence explicitly permits it.

`Score = sum over categories (weight × passed checks / 5)`

A check must hold for its stated sample and conditions. Where it specifies both themes or viewports, every specified condition must pass. Preserve the same fixture content, sample scope, thresholds, weights, and rubric version for comparisons. An app change should change results, not the rules; changing a threshold creates a new rubric version.

The thresholds and weights are explicit design judgments. The calculation is deterministic under this rubric; it is not a universal measurement of beauty or a complete accessibility certification.

| Category | Weight | Passed | Score |
| --- | ---: | ---: | ---: |
| Hierarchy & scanning | 15 | 4/5 | 12/15 |
| Typography & contrast | 15 | 2/5 | 6/15 |
| Action discoverability | 15 | 3/5 | 9/15 |
| Visual consistency | 10 | 5/5 | 10/10 |
| Feedback & recovery | 15 | 5/5 | 15/15 |
| Keyboard & semantics | 10 | 5/5 | 10/10 |
| Window layout & targets | 10 | 4/5 | 8/10 |
| Onboarding clarity | 10 | 4/5 | 8/10 |
| **Total** | **100** | **32/40** | **78/100** |

## Checks and baseline evidence

### Hierarchy & scanning — 12/15

Each check is worth **3 points**.

| ID | Result | Fixed pass condition | Evidence |
| --- | --- | --- | --- |
| H1 | PASS | The active mailbox has a filled row or non-color marker, and the list header names that mailbox. | Browser: Primary and All Inboxes have selected row fills and matching headers. |
| H2 | PASS | Unread conversations use both a non-color type change and an unread marker. | Browser + source: unread sender/subject use weight 600 plus a dot; read rows use regular weight. |
| H3 | PASS | The open conversation subject is at least 1.4× the app-rendered message body font size. | Browser: subject 22px; message body 14px; ratio 1.57. |
| H4 | PASS | Sidebar, list, and reader top toolbars share a height and top edge within 1 CSS px. | Browser: all three start at y=0 and are 44px high. |
| H5 | FAIL | In All Inboxes, an incoming conversation's owning account email is visible inside the reading pane without hover or opening compose. | Browser: Mira’s message shows mira@example.net and “to me”; the owning avery@example.com address is absent from the reading pane. List account dots require hover for the address. |

### Typography & contrast — 6/15

Each check is worth **3 points**.

| ID | Result | Fixed pass condition | Evidence |
| --- | --- | --- | --- |
| T1 | PASS | Primary mailbox names and conversation sender/subject text are at least 13 CSS px at 100% zoom. | Browser + tokens: primary labels and conversation text use 13px. |
| T2 | FAIL | App-rendered plain-text reading and compose bodies default to at least 15 CSS px with line-height at least 1.5. | Browser + CSS: both bodies use 14px with line-height 1.6. Size fails. Sender-supplied HTML mail is excluded. |
| T3 | FAIL | Enabled section labels, helper text, metadata, and input placeholders have at least 4.5:1 text/background contrast in both themes. | Browser + theme values: sidebar section labels are 2.82:1 in light and 3.51:1 in dark. Search placeholder colors also fall below 4.5:1. Decorative marks and disabled actions are excluded. |
| T4 | PASS | The fixture plain-text message wraps within its reader at both audit window sizes without clipping or horizontal scrolling. | Browser: Mira’s message fits the 680px reader at 1280px and wraps inside the 400px reader at 900px. |
| T5 | FAIL | An in-app text-size setting or documented app zoom command can increase reading and compose text to at least 18px. | Source: Appearance exposes theme and sidebar only; the app command registry has no text-size/zoom command. Browser or OS zoom alone does not satisfy this chosen product requirement. |

### Action discoverability — 9/15

Each check is worth **3 points**.

| ID | Result | Fixed pass condition | Evidence |
| --- | --- | --- | --- |
| A1 | FAIL | New message is a persistent action with a visible text label in the expanded sidebar. | Browser: a 28×28px pen icon, named through aria-label and a hover tooltip, is the only sidebar compose action. |
| A2 | PASS | Mail search and settings can each be reached with one click from the expanded shell. | Browser: visible search field and footer Settings button. |
| A3 | PASS | An open conversation offers visible text-labeled Reply, Reply all, and Forward actions. | Browser: all three appear below the conversation and are reachable by reader scrolling. |
| A4 | PASS | Every icon-only button in the shell's top toolbars has an accessible name and a text tooltip. | Browser + IconButton.tsx: New message, sidebar toggle, Archive, Delete, read state, Star, Reply, Forward, and More actions have aria-label and title. |
| A5 | FAIL | Before hover or an existing selection, the inbox shows a checkbox, Select action, or visible instruction explaining batch selection. | Browser + ThreadRow.tsx: avatars turn into checkboxes on hover or once a row is checked; no persistent Select affordance is shown. The palette exposes the shortcut but requires discovery. |

### Visual consistency — 10/10

Each check is worth **2 points**.

| ID | Result | Fixed pass condition | Evidence |
| --- | --- | --- | --- |
| C1 | PASS | App chrome uses one bundled font family across shell, compose, settings, and onboarding; keycaps/code and sender HTML are exempt. | Source + browser: shared IBM Plex Sans Variable family. |
| C2 | PASS | The repository's design-token check passes for the audited checkout. | Command: npm run lint:tokens exited 0. |
| C3 | PASS | Shell, settings, onboarding, and compose use the shared Button/IconButton components for their standard actions. | Source: shared component imports and consistent rendered button styles. |
| C4 | PASS | Standard chrome icons come from one family and use shared size/stroke tokens. | Source + browser: Lucide, 14px/16px icon sizes and 1.75 stroke token; brand art excluded. |
| C5 | PASS | Switching light/dark changes the same shell and settings surfaces without changing component geometry. | Browser + theme implementation: common CSS geometry with theme color tokens; theme change observed in settings and reader. |

### Feedback & recovery — 15/15

Each check is worth **3 points**.

| ID | Result | Fixed pass condition | Evidence |
| --- | --- | --- | --- |
| F1 | PASS | Archiving a fixture conversation shows a confirmation with Undo; Undo restores that conversation to the inbox. | Browser: “Archived / Undo” appeared; Undo restored “Icon sketches for the dock”. |
| F2 | PASS | Editing a valid fixture draft results in a visible saved confirmation without closing compose. | Browser: a valid recipient plus scratch subject produced “Draft saved” in the compose footer. |
| F3 | PASS | Trying to send an invalid recipient keeps compose open and shows an inline error identifying the invalid value. | Browser: invalid-address produced ““invalid-address” isn't an email address.” below the editor. |
| F4 | PASS | A search with no matches shows an explicit empty result and a one-click clear action that returns to mail. | Browser: zzzz-no-match-ui-audit yielded “No conversations match your search.”; Clear search returned the inbox. |
| F5 | PASS | Mail list and reader load-error UI provides an error message and a retry action for recoverable failures. | Source: ThreadList.tsx and ThreadView.tsx render error text and Try again controls. Native/network failure behavior was not exercised. |

### Keyboard & semantics — 10/10

Each check is worth **2 points**.

| ID | Result | Fixed pass condition | Evidence |
| --- | --- | --- | --- |
| K1 | PASS | Tab navigation shows a focus indicator at least 2 CSS px wide on the sampled settings switch. | Browser: the Show sidebar switch had a 2px solid teal outline after Tab. |
| K2 | PASS | Ctrl/Cmd+K opens a command palette and moves keyboard focus to its command input; Escape dismisses it. | Browser: Ctrl+K opened the command list with the combobox focused; Escape dismissed it. |
| K3 | PASS | A focused conversation list supports arrow navigation, Enter to open, and X to toggle selection. | Browser: ArrowDown + Enter opened “Keyboard map feedback”; X marked that option aria-selected=true. |
| K4 | PASS | Settings keeps Tab/Shift+Tab inside its dialog and restores the invoking button's focus on Escape. | Browser + source: initial Shift+Tab stayed in the dialog; Escape restored Settings focus; the trap wraps first/last controls. |
| K5 | PASS | The audited shell has named sidebar/list/reader landmarks, named controls, and associated labels for compose To/Subject/Message. | Accessibility tree + source: Mailboxes, Conversations, Reading pane, IconButton names, recipient aria-label, Subject label htmlFor, and Message editor aria-label. This is not a full screen-reader audit. |

### Window layout & targets — 8/10

Each check is worth **2 points**.

| ID | Result | Fixed pass condition | Evidence |
| --- | --- | --- | --- |
| R1 | PASS | At the supported 900×600 minimum, sidebar/list/reader stay inside the viewport without overlapping. | Browser: 220px + 280px + 400px panes; native minimum confirmed in tauri.conf.json. |
| R2 | PASS | Settings fits inside 900×600 with its close action visible and its content area scrollable. | Browser + CSS: dialog x=48,y=48,w=804,h=504; body uses overflow-y:auto. |
| R3 | PASS | Compose fits inside 900×600 and its Send action remains inside the viewport. | Browser: compose x=324,y=60,w=560,h=540; Send bottom=592. |
| R4 | PASS | The mailbox list has its own vertical scrolling while account/settings controls remain anchored in the footer. | Browser + shell CSS: sidebar scroll region above the fixed footer; long account/category/label navigation is contained independently. |
| R5 | FAIL | Secondary action buttons in the sampled reader and compose are at least 24×24 CSS px. | Browser: Remove label and Collapse message are 18×18px. This is a fixed ergonomic target, not a claim of a WCAG violation; spacing exceptions are not evaluated here. |

### Onboarding clarity — 8/10

Each check is worth **2 points**.

| ID | Result | Fixed pass condition | Evidence |
| --- | --- | --- | --- |
| O1 | PASS | Before setup starts, the UI states the Google Cloud prerequisite, expected time, and cost. | Browser: welcome explains ownership, about 15 minutes, and no cost. |
| O2 | PASS | Setup shows a numbered current step, offers backward navigation after the first step, and persists progress for resume. | Browser: 11-step rail, current-step styling, Back/Next on project step. Source: progress.ts and Onboarding.tsx save and restore the step. |
| O3 | PASS | Steps requiring fixed console values offer a copy control and a direct link to the relevant console page. | Browser: project step provides Open New Project and Copy. Source: steps.ts and shared guide render fixed-value copy fields and console links. |
| O4 | PASS | The credentials step uses visible field labels, masks the secret, and renders inline validation for malformed client IDs/JSON. | Source: Credentials in Onboarding.tsx renders Client ID/Client secret labels, password input, and field error text. |
| O5 | FAIL | The default setup path contains no required Next step solely for an unreleased feature. | Source + rail: Enable Calendar API is the fourth step; its copy says Calendar is coming. Make that step optional or defer it until Calendar is used. |

## Fixes and recoverable points

| Change | Failed check | Points |
| --- | --- | ---: |
| Raise informative subtle text/placeholder contrast to at least 4.5:1 in both themes. | T3 | +3 |
| Raise default reading and composing text to at least 15px, retaining line-height 1.6. | T2 | +3 |
| Add a persistent, text-labeled New message button. | A1 | +3 |
| Expose a Select action, checkbox, or batch-selection instruction before hover. | A5 | +3 |
| Show the owning account email in the incoming reader header under All Inboxes. | H5 | +3 |
| Add a text-size preference or documented app zoom command reaching 18px. | T5 | +3 |
| Increase the 18px secondary action hit areas to at least 24×24px. | R5 | +2 |
| Make Calendar API setup optional or defer it until Calendar is available. | O5 | +2 |
| **All eight fixes, assuming every existing pass remains valid** | | **+22 → 100** |

The first four changes recover **12 points**, giving a prospective **90/100** if all other checks still pass. This is arithmetic against the rubric, not a claim that unimplemented changes have been verified.

## Evidence locations

- `src/styles/tokens.css`, `src/styles/themes/light.ts`, `src/styles/themes/dark.ts`: type sizes and measured colors.
- `src/mail/ThreadRow.tsx`, `src/mail/MessageCard.tsx`, `src/mail/ThreadView.tsx`, `src/mail/ThreadList.tsx`: selection, account context, reading, empty/error states.
- `src/components/ui/IconButton.tsx`, `src/components/ui/Button.tsx`: action names, tooltips, shared controls.
- `src/compose/ComposePanel.tsx`, `src/compose/RecipientField.tsx`, `src/compose/compose.css`: draft status, validation, body text.
- `src/settings/Settings.tsx`, `src/settings/pages.tsx`, `src/settings/Settings.css`: keyboard trap, settings choices, sizing.
- `src/shell/AppShell.tsx`, `src/shell/shell.css`, `src-tauri/tauri.conf.json`: pane layout, navigation scrolling, supported minimum.
- `src/onboarding/Onboarding.tsx`, `src/onboarding/steps.ts`, `src/onboarding/progress.ts`: setup, validation, persistence, Calendar step.

Only this scorecard and its companion HTML were added by this audit; application code was not changed.
