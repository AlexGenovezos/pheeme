-- MCP (`local_api`, `mcp`): the MCP clients the user connected, and every tool they called.

-- One row per connected client. Only the SHA-256 of its token is kept (hex), so a lost token
-- means connecting again; deleting the row revokes it.
CREATE TABLE assistant_clients (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  -- ms since the epoch.
  created_at INTEGER NOT NULL,
  -- ms since the epoch; NULL until the client first calls a tool.
  last_used_at INTEGER
);

-- Every tool call, newest kept (the API trims to the latest 1,000). The client's name is
-- copied so the log still reads after the client is removed.
CREATE TABLE assistant_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  -- What it touched, in a few words (query, account, how many conversations).
  summary TEXT NOT NULL,
  -- The tool's arguments exactly as the client sent them (JSON).
  arguments TEXT NOT NULL,
  -- What came back (JSON): a write tool's whole answer; for a read, the conversations it
  -- returned (ids), not the mail itself. NULL when the call failed.
  result TEXT,
  -- NULL when the call succeeded.
  error TEXT,
  at INTEGER NOT NULL
);
