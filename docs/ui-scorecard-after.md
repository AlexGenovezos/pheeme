# Pheeme UI re-grade — rubric v1

**Result: 98/100, exceeding the requested 95/100 target.** The original rubric, category weights, and 40 pass conditions are unchanged. Baseline: 78/100.

Claude review caught a conflict between O5 and the design spec’s recorded Calendar setup decision. Calendar preparation is restored; O5 remains FAIL (two points). The earlier 100/100 result is superseded. The reviewer’s suggested 97.5 was an arithmetic error: this category has five checks worth two points each.

This is a checklist score under the agreed browser-and-source rubric, not a universal rating of design perfection. Scope: desktop browser fixtures at 1280×800 and 900×600 in light/dark themes; native Gmail/OAuth and a full screen-reader audit are excluded.

| Category | Before | After |
| --- | ---: | ---: |
| Hierarchy & scanning | 12/15 | 15/15 |
| Typography & contrast | 6/15 | 15/15 |
| Action discoverability | 9/15 | 15/15 |
| Visual consistency | 10/10 | 10/10 |
| Feedback & recovery | 15/15 | 15/15 |
| Keyboard & semantics | 10/10 | 10/10 |
| Window layout & targets | 8/10 | 10/10 |
| Onboarding clarity | 8/10 | 8/10 |
| **Total** | **78/100** | **98/100** |

## Checks and evidence

### Hierarchy & scanning

| ID | Original pass condition | Before → after | After evidence |
| --- | --- | --- | --- |
| H1 | The active mailbox has a filled row or non-color marker, and the list header names that mailbox. | PASS → PASS | Browser: Primary and All Inboxes have selected row fills and matching headers. |
| H2 | Unread conversations use both a non-color type change and an unread marker. | PASS → PASS | Browser + source: unread sender/subject use weight 600 plus a dot; read rows use regular weight. |
| H3 | The open conversation subject is at least 1.4× the app-rendered message body font size. | PASS → PASS | Browser: the subject is 24px with standard 16px body text (1.5×); Large uses 27px with 18px body text. |
| H4 | Sidebar, list, and reader top toolbars share a height and top edge within 1 CSS px. | PASS → PASS | Browser: all three start at y=0 and are 44px high. |
| H5 | In All Inboxes, an incoming conversation's owning account email is visible inside the reading pane without hover or opening compose. | FAIL → PASS | Browser: avery@example.com is visible above the incoming subject in All Inboxes, without hover. |

### Typography & contrast

| ID | Original pass condition | Before → after | After evidence |
| --- | --- | --- | --- |
| T1 | Primary mailbox names and conversation sender/subject text are at least 13 CSS px at 100% zoom. | PASS → PASS | Browser + tokens: primary labels and conversation text use 13px. |
| T2 | App-rendered plain-text reading and compose bodies default to at least 15 CSS px with line-height at least 1.5. | FAIL → PASS | Browser: default plain-text message and compose bodies are 16px with line-height 1.6. |
| T3 | Enabled section labels, helper text, metadata, and input placeholders have at least 4.5:1 text/background contrast in both themes. | FAIL → PASS | Theme values and regression tests: sidebar label contrast is 5.48:1 in light and 6.28:1 in dark. Search placeholders are 6.04:1 and 7.72:1. Disabled controls have a separate dimmer token; muted text remains stronger than subtle text in both themes. |
| T4 | The fixture plain-text message wraps within its reader at both audit window sizes without clipping or horizontal scrolling. | PASS → PASS | Browser: the updated message wraps inside the 400px reader at 900×600; its text box has equal clientWidth and scrollWidth (334px). The 1280×800 view also fits. |
| T5 | An in-app text-size setting or documented app zoom command can increase reading and compose text to at least 18px. | FAIL → PASS | Browser: Appearance → Reading → Text size → Large changes both reading and composing to 18px. A full reload restores the choice. Persistence and invalid stored values have regression tests. |

### Action discoverability

| ID | Original pass condition | Before → after | After evidence |
| --- | --- | --- | --- |
| A1 | New message is a persistent action with a visible text label in the expanded sidebar. | FAIL → PASS | Browser: a full-width text-labeled New message button is persistent under the window toolbar; the compose shortcut remains available. |
| A2 | Mail search and settings can each be reached with one click from the expanded shell. | PASS → PASS | Browser: visible search field and footer Settings button. |
| A3 | An open conversation offers visible text-labeled Reply, Reply all, and Forward actions. | PASS → PASS | Browser: all three appear below the conversation and are reachable by reader scrolling. |
| A4 | Every icon-only button in the shell's top toolbars has an accessible name and a text tooltip. | PASS → PASS | Browser + IconButton.tsx: New message, sidebar toggle, Archive, Delete, read state, Star, Reply, Forward, and More actions have aria-label and title. |
| A5 | Before hover or an existing selection, the inbox shows a checkbox, Select action, or visible instruction explaining batch selection. | FAIL → PASS | Browser: Select all is visible before hover. Clicking it selects all 22 loaded fixture conversations and announces 22 selected; Clear selection reverses it. |

### Visual consistency

| ID | Original pass condition | Before → after | After evidence |
| --- | --- | --- | --- |
| C1 | App chrome uses one bundled font family across shell, compose, settings, and onboarding; keycaps/code and sender HTML are exempt. | PASS → PASS | Source + browser: shared IBM Plex Sans Variable family. |
| C2 | The repository's design-token check passes for the audited checkout. | PASS → PASS | npm run lint passes, including the design-token guard. |
| C3 | Shell, settings, onboarding, and compose use the shared Button/IconButton components for their standard actions. | PASS → PASS | Source: shared component imports and consistent rendered button styles. |
| C4 | Standard chrome icons come from one family and use shared size/stroke tokens. | PASS → PASS | Source + browser: Lucide, 14px/16px icon sizes and 1.75 stroke token; brand art excluded. |
| C5 | Switching light/dark changes the same shell and settings surfaces without changing component geometry. | PASS → PASS | Browser + theme implementation: common CSS geometry with theme color tokens; theme change observed in settings and reader. |

### Feedback & recovery

| ID | Original pass condition | Before → after | After evidence |
| --- | --- | --- | --- |
| F1 | Archiving a fixture conversation shows a confirmation with Undo; Undo restores that conversation to the inbox. | PASS → PASS | Browser after changes: Archived / Undo appeared; Undo restored Icon sketches for the dock to the inbox. |
| F2 | Editing a valid fixture draft results in a visible saved confirmation without closing compose. | PASS → PASS | Browser after changes: the valid audit draft showed Draft saved in the compose footer. |
| F3 | Trying to send an invalid recipient keeps compose open and shows an inline error identifying the invalid value. | PASS → PASS | Browser after changes: invalid-address kept compose open and produced an inline error naming the invalid address. |
| F4 | A search with no matches shows an explicit empty result and a one-click clear action that returns to mail. | PASS → PASS | Browser after changes: an unmatched query shows No conversations match your search; Clear search returns to mail. |
| F5 | Mail list and reader load-error UI provides an error message and a retry action for recoverable failures. | PASS → PASS | Source: ThreadList.tsx and ThreadView.tsx render error text and Try again controls. Native/network failure behavior was not exercised. |

### Keyboard & semantics

| ID | Original pass condition | Before → after | After evidence |
| --- | --- | --- | --- |
| K1 | Tab navigation shows a focus indicator at least 2 CSS px wide on the sampled settings switch. | PASS → PASS | Browser after changes: the sampled Show sidebar switch has a 2px solid focus outline after Tab. |
| K2 | Ctrl/Cmd+K opens a command palette and moves keyboard focus to its command input; Escape dismisses it. | PASS → PASS | Browser after changes: Ctrl+K opens the command palette and focuses its combobox; Escape dismisses it. |
| K3 | A focused conversation list supports arrow navigation, Enter to open, and X to toggle selection. | PASS → PASS | Browser after changes: ArrowDown + Enter opened Dinner list; X marked the focused option selected. |
| K4 | Settings keeps Tab/Shift+Tab inside its dialog and restores the invoking button's focus on Escape. | PASS → PASS | Browser after changes: Tab wraps inside Settings and Escape restores focus to the invoking Settings button. The existing Shift+Tab trap remains in source and tests. |
| K5 | The audited shell has named sidebar/list/reader landmarks, named controls, and associated labels for compose To/Subject/Message. | PASS → PASS | Accessibility tree + source: Mailboxes, Conversations, Reading pane, IconButton names, recipient aria-label, Subject label htmlFor, and Message editor aria-label. This is not a full screen-reader audit. |

### Window layout & targets

| ID | Original pass condition | Before → after | After evidence |
| --- | --- | --- | --- |
| R1 | At the supported 900×600 minimum, sidebar/list/reader stay inside the viewport without overlapping. | PASS → PASS | Browser after changes: pane rectangles are 220px, 280px, and 400px at 900×600 with no horizontal overflow. |
| R2 | Settings fits inside 900×600 with its close action visible and its content area scrollable. | PASS → PASS | Browser after changes: Settings fits at x=48,y=48,w=804,h=504 at the supported minimum; its close action stays visible and the content scrolls. |
| R3 | Compose fits inside 900×600 and its Send action remains inside the viewport. | PASS → PASS | Browser after changes: the compose panel fits at 900×600 with Send inside the viewport, including Large text. |
| R4 | The mailbox list has its own vertical scrolling while account/settings controls remain anchored in the footer. | PASS → PASS | Browser + shell CSS: sidebar scroll region above the fixed footer; long account/category/label navigation is contained independently. |
| R5 | Secondary action buttons in the sampled reader and compose are at least 24×24 CSS px. | FAIL → PASS | Browser: every visible reader and compose action button in the sample is at least 24×24px. Label removal, message collapse, recipient edit/removal, attachment removal, and quote toggles use the shared minimum. |

### Onboarding clarity

| ID | Original pass condition | Before → after | After evidence |
| --- | --- | --- | --- |
| O1 | Before setup starts, the UI states the Google Cloud prerequisite, expected time, and cost. | PASS → PASS | Browser: welcome explains ownership, about 15 minutes, and no cost. |
| O2 | Setup shows a numbered current step, offers backward navigation after the first step, and persists progress for resume. | PASS → PASS | Browser and source: the original 11 numbered setup steps are retained, with Back and progress persistence unchanged. |
| O3 | Steps requiring fixed console values offer a copy control and a direct link to the relevant console page. | PASS → PASS | Browser: project step provides Open New Project and Copy. Source: steps.ts and shared guide render fixed-value copy fields and console links. |
| O4 | The credentials step uses visible field labels, masks the secret, and renders inline validation for malformed client IDs/JSON. | PASS → PASS | Source: Credentials in Onboarding.tsx renders Client ID/Client secret labels, password input, and field error text. |
| O5 | The default setup path contains no required Next step solely for an unreleased feature. | FAIL → FAIL | FAIL intentionally: Calendar API preparation is retained as required by the design spec (§4 and §8, decided by Alex). This original criterion conflicts with that decision and remains a two-point deduction. |

## Validation

Type checking, lint, the production build, and all 584 tests pass after the Claude review fixes. Review outcomes are recorded in [the Claude review ledger](ui-review-claude.md).

New regressions cover reading-size persistence/invalid storage, Appearance control behavior, secondary text/placeholder contrast, and disabled-vs-enabled text hierarchy. The original onboarding flow and its tests are restored.

## Comparison artifacts

- [Published comparison website](https://share.genovezos.dev/volunteer-manager/pheeme-ui-refresh) — GitHub sign-in required.
- [Interactive comparison](ui-comparison/index.html)
- [Machine-readable score evidence](ui-comparison/score.json)
- [Original baseline rubric](ui-scorecard.md)

Before screenshots are preserved unchanged. After screenshots are recaptured after review corrections with transient toast/focus state cleared. The same fixture scene and viewport are used; timestamps differ.

Application changes remain in the working checkout. Existing unrelated local changes are preserved.

## Sender-avatar follow-up — 05 Nov 2026

Removed initial avatars from conversation rows and expanded/collapsed message headers at Alex’s request. The list now uses visible 16px checkboxes inside 24px click targets, narrowing the leading column from 32px to 24px. Sender/account text and selection shortcuts remain. The five mail screenshots are refreshed; the original before images and rubric are unchanged (98/100).

Validation: 46 mail-list/reader tests, typecheck, lint, production build, and headless browser checks for checkbox selection, including clicks at the label edge. This cosmetic follow-up was made after Claude’s approval and was not sent for another review.

## Shipping validation — 05 Nov 2026

Integrated on current main while preserving account reconnection, navigation, and unread-count fixes. All 588 tests pass, along with typecheck, lint, formatting, version check, production build, eight label-script tests, and four Playwright browser checks. GPT-6.1 Sol approved the complete change in one round with no findings; see `ui-review-sol.md`.
