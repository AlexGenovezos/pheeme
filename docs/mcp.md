# MCP (AI assistants)

Pheeme can let AI assistants such as Claude Code work with your mail while Pheeme is open. It runs a
[Model Context Protocol](https://modelcontextprotocol.io) server on your computer only
(`http://127.0.0.1:43830/mcp`). Assistants go through Pheeme's local API, which does what the app's
own buttons do: the same cache, the same outbox, the same Gmail calls. Nothing touches the database
directly.

## Turn it on

1. Open **Settings › MCP** and turn on **Allow MCP connections**.
2. Under **Connect a client**, name it (for example "Claude Code") and choose **Connect**.
3. Copy the command Pheeme shows and run it in a terminal:

   ```sh
   claude mcp add --transport http pheeme http://127.0.0.1:43830/mcp --header "Authorization: Bearer pheeme_…"
   ```

   The token is shown once and only its hash is stored. If you lose it, connect again and remove the old
   entry.

Other MCP clients that speak Streamable HTTP take the same URL and `Authorization` header.

## What assistants can do

| Tool | What it does |
| --- | --- |
| `list_accounts` | The connected Gmail accounts |
| `list_labels` | Each account's labels and conversation counts |
| `list_mailbox` | Conversations in Inbox, a tab (Primary, Promotions…), Starred, Sent, Drafts, Spam, Trash, All Mail or a label |
| `search_mail` | Gmail search syntax over the cached mail, or Gmail's own search with `gmail: true` |
| `get_thread` | A conversation as plain text, with attachment names |
| `list_filters` | Every Gmail filter, in words, flagging those that delete mail, skip the inbox or mark it read |
| `sender_report` | Who sent the most mail over the last N days: how much, how much is unread, which tab it lands in, whether you ever write back, and whether it offers unsubscribe |
| `filter_audit` | For each filter that deletes, archives or marks mail read, what its criteria matched lately (Gmail search) and where that mail is now |

Writes come in groups, each off until you turn it on under **What clients may change**:

| Group | Tools |
| --- | --- |
| Organize mail | `archive`, `move_to_inbox`, `mark_read`, `mark_unread`, `star`, `unstar`, `change_labels`, `create_label`, `trash` |
| Change Gmail filters | `create_filter`, `delete_filter` |
| Write drafts | `create_draft` (new or a reply) |
| Unsubscribe | `unsubscribe`: one-click unsubscribe (RFC 8058) for lists that offer it; for others it returns the link |

Changes go through the same outbox as the app's buttons, so they show in Pheeme at once and reach
Gmail in order. A tool whose group is off answers with the setting to turn on.

Assistants can't send mail: drafts wait in Drafts for you. They don't include your signature yet
(Settings › Signatures applies to messages you write in Pheeme).

Try asking: "Audit my Gmail filters: is anything being deleted that shouldn't be?" or "Who sends me the
most mail, and what should I filter or unsubscribe from?"

## Safety

- Off by default, and every write group off by default. Turning the main switch off stops the server.
- Loopback only: the server never listens on a network interface, and refuses requests whose `Host` or
  `Origin` isn't `127.0.0.1`/`localhost` on its port.
- Each assistant has its own token. **Remove** revokes it at once.
- One-click unsubscribe only POSTs to an https link on a public host name, never to an IP address or a
  local name, and doesn't follow redirects.
- **Activity** lists every tool call (Pheeme keeps the latest 1,000): which client, which tool, when, and
  any error. Open a call to see exactly what it sent (its arguments, as received) and what came back: a
  change's whole answer, or for a read, the ids of the conversations, messages and filters it returned
  (the mail itself isn't copied into the log). Calls Pheeme refused are listed too.

If port 43830 is taken, Settings says so; quit whatever is using it and turn the switch off and on.
