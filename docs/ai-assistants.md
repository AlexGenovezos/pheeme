# AI assistants (MCP)

Pheeme can let AI assistants such as Claude Code work with your mail while Pheeme is open. It runs a
[Model Context Protocol](https://modelcontextprotocol.io) server on your computer only
(`http://127.0.0.1:43830/mcp`). Assistants go through Pheeme's local API, which does what the app's
own buttons do: the same cache, the same outbox, the same Gmail calls. Nothing touches the database
directly.

## Turn it on

1. Open **Settings › AI assistants** and turn on **Allow AI assistants**.
2. Under **Connect an assistant**, name it (for example "Claude Code") and choose **Connect**.
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

Assistants can't send mail.

## Safety

- Off by default. Turning it off stops the server.
- Loopback only: the server never listens on a network interface, and refuses requests whose `Host` or
  `Origin` isn't `127.0.0.1`/`localhost` on its port.
- Each assistant has its own token. **Remove** revokes it at once.
- **Activity** lists the latest tool calls (Pheeme keeps 1,000), with what each touched and any error.

If port 43830 is taken, Settings says so; quit whatever is using it and turn the switch off and on.
