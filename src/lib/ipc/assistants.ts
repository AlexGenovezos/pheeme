import { call } from "./call";

/** An MCP client (an AI assistant) connected in Settings › MCP. */
export interface AssistantClient {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}
/** A group of assistant write tools the user allows separately. */
export type AssistantPermission =
  | "organize"
  | "filters"
  | "drafts"
  | "unsubscribe"
  | "calendar"
  | "tasks";
/** Whether assistants are allowed, the MCP server's state, the connected clients and the write groups allowed. */
export interface AssistantStatus {
  enabled: boolean;
  server: { state: "off" | "running" | "failed"; url: string; message: string | null };
  clients: AssistantClient[];
  allowed: AssistantPermission[];
}
/** A newly connected assistant; `token` is shown once and never stored in the clear. */
export interface NewAssistant {
  client: AssistantClient;
  token: string;
}
/** One tool call an MCP client made. */
export interface AssistantActivity {
  id: number;
  clientName: string;
  tool: string;
  summary: string;
  /** The arguments exactly as sent (JSON). */
  arguments: string;
  /** What came back (JSON): a change's whole answer, or the ids a read returned. Null when it failed. */
  result: string | null;
  error: string | null;
  at: number;
}
export const assistantStatus = () => call("assistant_status");
export const setAssistantEnabled = (enabled: boolean) => call("set_assistant_enabled", { enabled });
export const setAssistantPermission = (permission: AssistantPermission, allowed: boolean) =>
  call("set_assistant_permission", { permission, allowed });
export const connectAssistant = (name: string) => call("connect_assistant", { name });
export const removeAssistant = (clientId: string) => call("remove_assistant", { clientId });
export const assistantActivity = () => call("assistant_activity");
export const clearAssistantActivity = () => call("clear_assistant_activity");
