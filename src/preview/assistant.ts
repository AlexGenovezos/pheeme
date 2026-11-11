/** Settings › MCP for browser preview (`src-tauri/src/local_api` and `src-tauri/src/mcp` in the app). */

import type {
  AssistantActivity,
  AssistantClient,
  AssistantPermission,
  AssistantStatus,
  NewAssistant,
} from "../lib/tauri";

type Args = Record<string, unknown> | undefined;

const URL = "http://127.0.0.1:43830/mcp";

export function createAssistantHandlers() {
  let enabled = false;
  let next = 0;
  const clients: AssistantClient[] = [];
  let activity: AssistantActivity[] = [];
  let allowed: AssistantPermission[] = [];
  const status = (): AssistantStatus => ({
    enabled,
    server: { state: enabled ? "running" : "off", url: URL, message: null },
    clients: clients.map((c) => ({ ...c })),
    allowed: [...allowed],
  });
  return {
    assistant_status: () => status(),
    set_assistant_enabled: (args: Args) => {
      enabled = Boolean(args?.enabled);
      return status();
    },
    set_assistant_permission: (args: Args) => {
      const permission = String(args?.permission) as AssistantPermission;
      allowed = allowed.filter((p) => p !== permission);
      if (args?.allowed) allowed.push(permission);
      return status();
    },
    connect_assistant: (args: Args): NewAssistant => {
      const name = String(args?.name ?? "").trim();
      if (!name) throw { code: "invalid_input", message: "Give the assistant a name." };
      next += 1;
      const client = { id: `client-${next}`, name, createdAt: Date.now(), lastUsedAt: null };
      clients.push(client);
      activity = [
        {
          id: next,
          clientName: name,
          tool: "list_mailbox",
          summary: "inbox (unread)",
          arguments: JSON.stringify({ mailbox: "inbox", unread_only: true }),
          result: JSON.stringify({ thread_ids: ["t1", "t2"] }),
          error: null,
          at: Date.now(),
        },
        ...activity,
      ];
      return { client: { ...client }, token: `pheeme_preview${next}` };
    },
    remove_assistant: (args: Args) => {
      const at = clients.findIndex((c) => c.id === args?.clientId);
      if (at >= 0) clients.splice(at, 1);
    },
    assistant_activity: () => activity.map((a) => ({ ...a })),
    clear_assistant_activity: () => {
      activity = [];
    },
  };
}
