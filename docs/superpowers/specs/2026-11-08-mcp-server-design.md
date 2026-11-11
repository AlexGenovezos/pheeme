# AI assistants: a local MCP server

Issue: #6. Status: design, agreed with Alex 2026-11-08 ("full stop" after the conversation below); calls marked
**My call** are the author's, for Alex to check.

## Why

Alex wants an AI assistant (Claude Code, run from T3 Code) to work with his mail through Pheeme: check mail, make
rules, and do the basic actions. Two jobs come first:

1. **Filter audit.** His own Gmail filters send mail to Trash (or past the inbox) that he would have wanted. He
   wants to ask "what are my filters deleting that they shouldn't?" and get the filters, what each one actually
   caught, and the option to fix or delete the bad ones.
2. **Volume report.** "What am I getting a lot of, and should I make a rule or unsubscribe?" Who sends the most,
   how much of it he reads, and whether it can be unsubscribed from.

Beyond those, "all types of basic functionality": search, read, archive, label, mark read, star, trash, drafts.

He was explicit that it must be **native, through an API, not its own way into the database**: the assistant does
what the app's own buttons do, through the same services, so sync, the outbox and Gmail all behave exactly as if he
had clicked.

Success: in a Claude Code session, "audit my filters" and "who sends me the most mail?" give real answers about
his mailbox, and "archive these / make a filter for that / unsubscribe from them" happens in Gmail, visible in
Pheeme straight away.

## Goals

- Pheeme runs an MCP server while it is open, which Claude Code (and any MCP client that speaks Streamable HTTP)
  connects to with one `claude mcp add` command copied from Settings.
- Tools cover reading (accounts, labels, mailboxes, search, threads, filters), organising (archive, read, star,
  labels, inbox, trash), Gmail filters (create, delete), drafts, and the two reports plus unsubscribe.
- Everything goes through a **local API** layer (`local_api`), which is the only thing the MCP server talks to.
  The API enforces the on/off switch, client tokens, per-group permissions and the activity log, once. It calls
  the existing services (`MailService`, `LabelService`, `ComposeService`, the filters API), never SQL of its own.
  A later scripting API or CLI would be a second adapter over the same layer (issue #6, "MCP goes through the
  API").

## Non-goals

- Working while Pheeme is closed (Alex: fine that it only works while the app is open).
- Sending mail. The design doc's rule stands: **drafts only**, a person sends them from Pheeme.
- Calendar tools (Calendar mode doesn't exist yet).
- A stdio shim or a network-reachable server.
- Taking mail out of Trash or Spam: the outbox can't untrash yet (the UI can't either). The audit reports what
  filters caught; rescuing is a follow-up that adds untrash to the outbox for the UI and the assistant together.

## Anti-goals

- A second data path: an assistant change that skips the outbox, or a read that bypasses the services' rules
  (Spam/Trash handling, body fetch, label names).
- Listening on anything but loopback, or answering without a valid token.
- Write access the user didn't turn on. Off by default, each group of writes off by default.
- An assistant able to send mail, or delete filters Pheeme can't describe back to the user.

## Shape

### Transport

- MCP **Streamable HTTP**, `POST http://127.0.0.1:<port>/mcp`, JSON-RPC 2.0. Responses are plain JSON
  (`application/json`); the server never opens an SSE stream (`GET` answers 405), which the spec allows.
- **My call:** fixed default port 43830, bound on 127.0.0.1 only. If it's taken, Settings says so.
- Every request needs `Authorization: Bearer <token>`. Requests with an `Origin` or `Host` that isn't the loopback
  address and port are refused (DNS-rebinding defence the MCP spec requires).
- Protocol versions 2025-03-26, 2025-06-18 and 2025-11-25; the server answers with the client's if it knows it,
  else its newest.
- Methods: `initialize`, `notifications/initialized` (and any notification: 202), `ping`, `tools/list`,
  `tools/call`. Tool failures come back as tool results with `isError: true` and the API's plain message, so the
  model can read them.

### Clients and tokens

- Settings › AI assistants › **Connect an assistant**: name it ("Claude Code"), and Pheeme shows a token once, with
  the ready command: `claude mcp add --transport http pheeme http://127.0.0.1:43830/mcp --header
  "Authorization: Bearer <token>"`, and a Copy button.
- **My call:** one token per client; only its SHA-256 is stored (`assistant_clients`), so a lost token means
  connecting again. Removing a client revokes it at once. The list shows each client's last use.

### Permissions

- A master switch, **Allow AI assistants**, off by default. Off stops the server.
- Reading is allowed whenever the switch is on. Writes come in groups, each off by default:
  - **Organize mail:** archive, move to inbox, read/unread, star/unstar, add/remove labels, trash, create label.
  - **Gmail filters:** create and delete filters.
  - **Drafts:** create drafts (new or reply).
  - **Unsubscribe:** one-click unsubscribe.
- A tool whose group is off returns an error naming the setting to turn on. **My call:** tools stay listed so the
  assistant can tell the user what to enable.

### Activity log

- Every `tools/call` is recorded (`assistant_activity`): when, which client, which tool, a short summary of what
  it touched (query, account, thread count), and whether it failed. Settings shows the latest 50; the table keeps
  the latest 1,000. Local only.

### Tools

Account arguments take an email address or account id; label arguments take a name or id. Thread rows carry
label **names**, not ids, and ISO dates. Lists are paged with an opaque `cursor`.

Read: `list_accounts`, `list_labels`, `list_mailbox` (inbox, starred, sent, drafts, spam, trash, all, or a label;
optional unread only), `search_mail` (Gmail syntax; the local cache first, Gmail's own search when asked or when the
query needs it), `get_thread` (plain-text bodies, long ones cut with a note, attachment names), `list_filters`
(every filter, criteria and actions in words, label names resolved).

Organize: `archive`, `move_to_inbox`, `mark_read`, `mark_unread`, `star`, `unstar`, `change_labels`, `trash`,
`create_label`. All through `MailService`/`LabelService`, so the outbox does the Gmail work.

Filters: `create_filter` (criteria: from, to, subject, query, negated query, has attachment; actions: add label,
skip inbox, mark read, star, trash, never spam, mark important or not, forward is **not** offered), `delete_filter`.

Drafts: `create_draft` (to, cc, bcc, subject, plain-text body; or a reply to a message id, using Pheeme's reply
template).

Reports:
- `sender_report`: top senders over the last N days (default 90) from the cache: messages, unread, how many sit in
  Inbox, Trash and Spam, their inbox category, the newest date, and whether the newest message offers unsubscribe
  (fetched as headers from Gmail for the senders listed).
- `filter_audit`: for each filter that trashes, skips the inbox or marks read, the Gmail search equivalent of its
  criteria and a sample of what it matched in the last N days (Gmail search), so the assistant can point at
  wrongly caught mail.
- `unsubscribe`: for a message, reads `List-Unsubscribe` / `List-Unsubscribe-Post`. One-click (RFC 8058, https
  with `List-Unsubscribe=One-Click`) is performed when the Unsubscribe group is on; otherwise, or for mailto/web
  links, the link is returned for the user. **My call:** never a mailto send (that's sending mail).

## Delivery

A stack of three PRs:

1. Local API + MCP server + read tools + Settings page (switch, connect, clients, activity).
2. Write tools and their permission switches.
3. Sender report, filter audit, unsubscribe.

## Left to the builder

Module names, the port constant, exact tool argument names, summary wording in the activity log, page copy.
