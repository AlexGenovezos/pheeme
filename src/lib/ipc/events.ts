import { type Event, listen as listenRaw, type UnlistenFn } from "@tauri-apps/api/event";
import type { CalendarAccess } from "./calendar";
import type { TasksAccess } from "./tasks";

/** Emitted after each assistant tool call. */
export const ASSISTANT_ACTIVITY_EVENT = "assistant:activity";

/** Google stopped or started answering this device. Offline, syncing pauses and changes wait. */
export const NETWORK_EVENT = "network:status";

export const SYNC_EVENTS = {
  started: "sync:started",
  messagesUpdated: "sync:messages_updated",
  labelsUpdated: "sync:labels_updated",
  completed: "sync:completed",
  error: "sync:error",
  rateLimited: "sync:rate_limited",
  outboxRejected: "outbox:rejected",
  outboxSendStatus: "outbox:send_status",
} as const;

/** Emitted while an opened thread's bodies are fetched from Gmail; cached opens emit nothing. */
export const THREAD_LOADING_EVENT = "mail:thread_loading";

export const CALENDAR_EVENTS = {
  /** `{ accountId }`: cached calendars or events changed. */
  updated: "calendar:updated",
  /** `{ accountId, status }`: the account's calendar access changed. */
  access: "calendar:access",
} as const;

export const TASKS_EVENTS = {
  /** `{ accountId }`: cached task lists or tasks changed. */
  updated: "tasks:updated",
  /** `{ accountId, status }`: the account's tasks access changed. */
  access: "tasks:access",
} as const;

/** Emitted by the macOS app menu's "Check for Updates…" item (src-tauri/src/app_menu.rs). */
export const CHECK_FOR_UPDATES_EVENT = "check-for-updates";

/** Rust asks for every open message to be saved before the app quits (`commands/compose.rs`). */
export const SAVE_BEFORE_EXIT_EVENT = "compose:save_before_exit";

export interface NetworkStatusEvent {
  online: boolean;
}

export interface ThreadLoading {
  accountId: string;
  threadId: string;
  /** `queued`: waiting for a request slot or quota. `done`: the bodies are stored, or fetching them failed. */
  stage: "queued" | "fetching" | "retrying" | "done";
  /** Retries so far (0 for the first retry), while `retrying`. */
  attempt: number | null;
  retryInMs: number | null;
  reason: "rate_limited" | "network" | "server" | null;
  /** The account's initial sync or backfill is running. */
  syncBusy: boolean;
}

export interface SyncAccountEvent {
  accountId: string;
}

export interface SyncMessagesUpdated extends SyncAccountEvent {
  /** Thread ids. */
  added: string[];
  removed: string[];
  modified: string[];
}

export interface SyncErrorEvent extends SyncAccountEvent {
  code: string;
  message: string;
}

/** Gmail refused a sync or backfill request for quota; fires on every refusal. */
export interface SyncRateLimitedEvent extends SyncAccountEvent {
  retryInMs: number | null;
}

export interface OutboxRejected extends SyncAccountEvent {
  opId: string;
  kind: string;
  message: string;
}

export interface OutboxSendStatus extends SyncAccountEvent {
  opId: string;
  status: string;
}

/** Every event the window listens for, with what it carries (`void`: nothing). */
export interface AppEvents {
  [SYNC_EVENTS.started]: SyncAccountEvent;
  [SYNC_EVENTS.messagesUpdated]: SyncMessagesUpdated;
  [SYNC_EVENTS.labelsUpdated]: SyncAccountEvent;
  [SYNC_EVENTS.completed]: SyncAccountEvent;
  [SYNC_EVENTS.error]: SyncErrorEvent;
  [SYNC_EVENTS.rateLimited]: SyncRateLimitedEvent;
  [SYNC_EVENTS.outboxRejected]: OutboxRejected;
  [SYNC_EVENTS.outboxSendStatus]: OutboxSendStatus;
  [NETWORK_EVENT]: NetworkStatusEvent;
  [THREAD_LOADING_EVENT]: ThreadLoading;
  [CALENDAR_EVENTS.updated]: SyncAccountEvent;
  [CALENDAR_EVENTS.access]: SyncAccountEvent & { status: CalendarAccess["status"] };
  [TASKS_EVENTS.updated]: SyncAccountEvent;
  [TASKS_EVENTS.access]: SyncAccountEvent & { status: TasksAccess["status"] };
  [ASSISTANT_ACTIVITY_EVENT]: void;
  /** Settings › MCP or a mod changed what's installed or running. */
  "mods:changed": void;
  /** A notification was clicked; `take_notification_target` says where it goes. */
  "desktop:open-thread": void;
  /** A desktop notification failed, in words for the user. */
  "desktop:error": string;
  [CHECK_FOR_UPDATES_EVENT]: void;
  [SAVE_BEFORE_EXIT_EVENT]: void;
}

/** Listen for an app event; the payload type comes from `AppEvents`. */
export function listen<K extends keyof AppEvents>(
  name: K,
  handler: (event: Event<AppEvents[K]>) => void,
): Promise<UnlistenFn> {
  return listenRaw<AppEvents[K]>(name, handler);
}

/** Call an event unlisten fn, ignoring failures (e.g. the IPC bridge is already gone). */
export function stopQuietly(stop: () => void) {
  try {
    void Promise.resolve(stop() as unknown).catch(() => {});
  } catch {
    // Nothing to clean up.
  }
}
