// Every Rust command the window invokes: its name, the one argument object it takes and what it
// resolves to. `call` checks the wrappers against this, and the browser preview's fakes
// (src/preview/) are typed against it too, so a renamed command or argument fails typecheck in both.
// Add a command here, then a wrapper in its domain file.
import type { PersonProfile } from "../../contacts/api";
import type { DesktopSettings, NotifySchedule, NotifyTarget } from "../../desktop/api";
import type { DrivePage, DriveFile } from "../../drive/api";
import type { ModSnapshot, PreparedMod } from "../../mods/api";
import type { LocalNetworkAccess, TransferOffer, TransferStatus } from "../../transfer/api";
import type { AccountInfo, ClientChoice, QuotaUsage, SignInStart } from "./accounts";
import type { UsageBatch } from "./support";
import type {
  AssistantActivity,
  AssistantPermission,
  AssistantStatus,
  NewAssistant,
} from "./assistants";
import type {
  AvailabilityResult,
  CalendarAccess,
  CalendarAccount,
  CalendarEvent,
} from "./calendar";
import type {
  AddedFileEvents,
  CalendarFile,
  EditScope,
  EventDetail,
  EventEdit,
  EventRef,
  EventTemplate,
  Invite,
  SendUpdates,
  TemplateFields,
} from "./calendarEvents";
import type {
  ComposeDraft,
  ComposeMode,
  DraftSummary,
  FailedSend,
  QueuedSend,
  SavedDraft,
  SendAsAddress,
  SignatureSettings,
  StagedAttachment,
} from "./compose";
import type { ContactSuggestion, GoogleContactsStatus } from "./contacts";
import type { LabelColor, LabelCount, LabelDeletePreview, LabelEdit, LabelInfo } from "./labels";
import type {
  ListThreadsArgs,
  MailboxCount,
  SyncProgress,
  ThreadCursor,
  ThreadDetail,
  ThreadPage,
} from "./mail";
import type { GmailSearchPage, SearchPage } from "./search";
import type { InboxThread, SavedRules, SenderRule } from "./senderRules";
import type { ClearedDownloads, ThemeFolderFile } from "./settings";
import type { MailStats, Unsubscribed } from "./stats";
import type {
  DiagnosticsEmail,
  PreparedScreenshot,
  PreviewReport,
  ShownTiming,
  UpdateEvent,
  WindowProblem,
} from "./support";
import type { Task, TaskEdit, TaskListRef, TaskRef, TasksAccess, TasksAccount } from "./tasks";
import type { Forecast, LocationForecast, TemperatureUnit, WeatherPlace } from "./weather";

/** One command: `args` is `void` when it takes none. */
interface Command<Args, Result> {
  args: Args;
  result: Result;
}

type Account = { accountId: string };
type Calendar = Account & { calendarId: string };
type CalendarEventId = Calendar & { eventId: string };
type TaskList = Account & { listId: string };
type TaskId = TaskList & { taskId: string };
type Attachment = Account & { messageId: string; attachmentId: string };
type Rsvp = "accepted" | "tentative" | "declined";

export interface Commands {
  // Accounts and sign-in
  begin_oauth: Command<{ client: ClientChoice }, SignInStart>;
  complete_oauth: Command<{ flowId: string }, AccountInfo>;
  cancel_oauth: Command<{ flowId: string }, void>;
  list_accounts: Command<void, AccountInfo[]>;
  remove_account: Command<Account, void>;
  set_account_color: Command<Account & { color: number }, void>;
  reorder_accounts: Command<{ accountIds: string[] }, void>;
  open_external: Command<{ url: string }, void>;
  gmail_quota: Command<void, number>;
  set_gmail_quota: Command<{ perMinute: number }, number>;
  gmail_quota_usage: Command<Account, QuotaUsage>;

  // Mail: reading and changing conversations
  list_threads: Command<ListThreadsArgs, ThreadPage>;
  get_thread: Command<
    Account & { threadId: string; opened: boolean; preload: boolean },
    ThreadDetail
  >;
  mailbox_counts: Command<{ accountIds: string[] }, MailboxCount[]>;
  modify_threads: Command<Account & { threadIds: string[]; add: string[]; remove: string[] }, void>;
  mark_inbox_tab_read: Command<Account & { category: string }, void>;
  mark_search_read: Command<{ accountIds: string[]; query: string }, void>;
  trash_threads: Command<Account & { threadIds: string[] }, void>;
  get_sync_progress: Command<void, SyncProgress[]>;
  network_online: Command<void, boolean>;
  open_mail_link: Command<{ url: string }, void>;

  // Mail: attachments
  save_attachment: Command<Attachment, string>;
  read_attachment: Command<Attachment, ArrayBuffer>;
  prefetch_attachments: Command<Account & { messageIds: string[] }, void>;
  open_attachment: Command<Attachment, void>;
  reveal_download: Command<{ path: string }, void>;
  save_attachment_to_drive: Command<Attachment, DriveFile>;
  drive_files: Command<Account & { query: string; pageToken: string | null }, DrivePage>;

  // Labels and inbox tabs
  list_labels: Command<Account, LabelInfo[]>;
  label_counts: Command<Account, LabelCount[]>;
  inbox_tabs: Command<Account, string[]>;
  set_inbox_tabs: Command<Account & { hidden: string[] }, string[]>;
  create_label: Command<Account & { name: string; color: LabelColor | null }, LabelInfo>;
  update_label: Command<Account & { labelId: string; edit: LabelEdit }, LabelInfo[]>;
  delete_label: Command<Account & { labelId: string }, void>;
  delete_label_preview: Command<Account & { labelId: string }, LabelDeletePreview>;

  // Search
  search_messages: Command<
    {
      accountIds: string[];
      query: string;
      before: ThreadCursor | null;
      limit: number | null;
    },
    SearchPage
  >;
  search_gmail: Command<
    { accountIds: string[]; query: string; pageTokens: Record<string, string> | null },
    GmailSearchPage
  >;
  recent_searches: Command<void, string[]>;
  add_recent_search: Command<{ query: string }, void>;
  remove_recent_search: Command<{ query: string | null }, void>;

  // Sender rules (Gmail filters)
  list_sender_rules: Command<Account, SenderRule[]>;
  rule_senders: Command<Account & { threadIds: string[] }, string[]>;
  save_sender_rules: Command<Account & { senders: string[]; category: string }, SavedRules>;
  undo_sender_rules: Command<Account & { saved: SavedRules }, void>;
  delete_sender_rule: Command<Account & { ruleId: string }, void>;
  inbox_threads_from: Command<Account & { senders: string[]; category: string }, InboxThread[]>;

  // Stats
  mail_stats: Command<{ accountId: string | null; sinceMs: number }, MailStats>;
  unsubscribe_sender: Command<
    Account & { threadId: string; messageId: string | null },
    Unsubscribed
  >;

  // Compose
  compose_template: Command<Account & { messageId: string; mode: ComposeMode }, ComposeDraft>;
  gmail_signature: Command<Account, string | null>;
  signature_settings: Command<Account, SignatureSettings | null>;
  set_signature_settings: Command<Account & { settings: SignatureSettings }, void>;
  send_as_addresses: Command<Account, SendAsAddress[]>;
  stage_attachment: Command<{ path: string }, StagedAttachment>;
  stage_pasted_attachment: Command<
    { filename: string; mimeType: string; data: string },
    StagedAttachment
  >;
  discard_attachments: Command<{ ids: string[] }, void>;
  save_draft: Command<Account & { message: ComposeDraft }, SavedDraft>;
  open_draft: Command<Account & { messageId: string }, ComposeDraft>;
  delete_draft: Command<Account & { draftId: string }, void>;
  send_email: Command<Account & { message: ComposeDraft; undoMs: number | null }, QueuedSend>;
  cancel_send: Command<{ opId: string }, boolean>;
  failed_sends: Command<Account, FailedSend[]>;
  reopen_failed_send: Command<
    Account & { opId: string },
    { draftId: string; messageId: string } | null
  >;

  // Contacts
  suggest_contacts: Command<Account & { query: string; limit?: number }, ContactSuggestion[]>;
  google_contacts_status: Command<Account, GoogleContactsStatus>;
  refresh_google_contacts: Command<Account, GoogleContactsStatus>;
  person_profile: Command<Account & { address: string; displayTz: string }, PersonProfile>;
  save_person_contact: Command<Account & { address: string; name: string | null }, void>;

  // Calendar
  calendar_accounts: Command<void, CalendarAccount[]>;
  calendar_events: Command<{ fromMs: number; toMs: number; timeZone: string }, CalendarEvent[]>;
  search_calendar_events: Command<
    { query: string; fromMs: number; toMs: number; timeZone: string },
    CalendarEvent[]
  >;
  set_calendar_hidden: Command<Calendar & { hidden: boolean }, void>;
  set_calendar_color: Command<Calendar & { background: string; foreground: string }, void>;
  calendar_sync_now: Command<Account, CalendarAccess>;
  calendar_availability: Command<
    Account & { emails: string[]; fromMs: number; toMs: number },
    AvailabilityResult
  >;
  set_calendar_foreground: Command<{ on: boolean }, void>;
  open_meeting_link: Command<{ url: string }, void>;
  calendar_event_detail: Command<CalendarEventId, EventDetail>;
  create_calendar_event: Command<
    Calendar & { edit: EventEdit; sendUpdates: SendUpdates },
    EventRef
  >;
  update_calendar_event: Command<
    CalendarEventId & { scope: EditScope; edit: EventEdit; sendUpdates: SendUpdates },
    EventRef
  >;
  delete_calendar_event: Command<
    CalendarEventId & { scope: EditScope; sendUpdates: SendUpdates },
    void
  >;
  move_calendar_event: Command<
    CalendarEventId & { destinationCalendarId: string; sendUpdates: SendUpdates },
    EventRef
  >;
  copy_calendar_event: Command<
    CalendarEventId & { toAccountId: string; toCalendarId: string },
    EventRef
  >;
  respond_to_calendar_event: Command<
    CalendarEventId & { scope: EditScope; response: Rsvp; comment: string | null },
    EventRef
  >;
  respond_to_calendar_invite: Command<
    Account & {
      icalUid: string;
      response: Rsvp;
      comment: string | null;
      import: Record<string, unknown> | null;
    },
    EventRef
  >;
  message_invite: Command<Account & { messageId: string }, Invite | null>;
  calendar_file: Command<
    Account & { messageId: string; attachmentId: string | null },
    CalendarFile | null
  >;
  add_calendar_file_events: Command<
    Account & {
      messageId: string;
      attachmentId: string | null;
      targetAccountId: string;
      calendarId: string;
      uids: string[];
    },
    AddedFileEvents
  >;
  event_templates: Command<void, EventTemplate[]>;
  save_event_template: Command<
    { name: string; fields: TemplateFields; replace: boolean },
    EventTemplate
  >;
  rename_event_template: Command<{ id: string; name: string }, EventTemplate>;
  delete_event_template: Command<{ id: string }, void>;

  // Weather
  weather_search_places: Command<{ query: string }, WeatherPlace[]>;
  weather_forecast: Command<
    { latitude: number; longitude: number; unit: TemperatureUnit },
    Forecast
  >;
  weather_for_location: Command<
    { location: string; unit: TemperatureUnit },
    LocationForecast | null
  >;

  // Google Tasks
  tasks_accounts: Command<void, TasksAccount[]>;
  tasks_in_list: Command<TaskList, Task[]>;
  dated_tasks: Command<{ fromDate: string; toDate: string }, Task[]>;
  tasks_due_through: Command<{ throughDate: string }, Task[]>;
  set_task_list_hidden: Command<TaskList & { hidden: boolean }, void>;
  tasks_sync_now: Command<Account, TasksAccess>;
  create_task: Command<
    TaskList & { edit: TaskEdit; parent: string | null; previous: string | null },
    TaskRef
  >;
  update_task: Command<TaskId & { edit: TaskEdit }, TaskRef>;
  set_task_completed: Command<TaskId & { completed: boolean }, TaskRef>;
  delete_task: Command<TaskId, void>;
  move_task: Command<TaskId & { parent: string | null; previous: string | null }, TaskRef>;
  move_task_to_list: Command<TaskId & { destinationListId: string }, TaskRef>;
  create_task_list: Command<Account & { title: string }, TaskListRef>;
  rename_task_list: Command<TaskList & { title: string }, TaskListRef>;
  delete_task_list: Command<TaskList, void>;

  // Assistants (MCP)
  assistant_status: Command<void, AssistantStatus>;
  set_assistant_enabled: Command<{ enabled: boolean }, AssistantStatus>;
  set_assistant_permission: Command<
    { permission: AssistantPermission; allowed: boolean },
    AssistantStatus
  >;
  connect_assistant: Command<{ name: string }, NewAssistant>;
  remove_assistant: Command<{ clientId: string }, void>;
  assistant_activity: Command<void, AssistantActivity[]>;
  clear_assistant_activity: Command<void, void>;

  // Desktop: notifications and the tray
  desktop_settings: Command<void, DesktopSettings>;
  set_account_notifications: Command<Account & { enabled: boolean }, DesktopSettings>;
  answer_notification_prompt: Command<{ enable: boolean }, DesktopSettings>;
  set_tray_icon: Command<{ shown: boolean }, DesktopSettings>;
  take_notification_target: Command<void, NotifyTarget | null>;
  set_calendar_reminders: Command<{ enabled: boolean }, DesktopSettings>;
  set_notification_schedule: Command<{ schedule: NotifySchedule }, DesktopSettings>;

  // Client transfer between devices
  local_network_access: Command<void, LocalNetworkAccess>;
  open_local_network_settings: Command<void, void>;
  transfer_interfaces: Command<void, string[]>;
  offer_client_transfer: Command<Account & { address: string }, TransferOffer>;
  client_transfer_status: Command<{ transferId: string }, TransferStatus>;
  approve_client_transfer: Command<{ transferId: string }, void>;
  cancel_client_transfer: Command<{ transferId: string }, void>;
  receive_client_transfer: Command<{ transferId: string; invitation: string }, SignInStart>;

  // Mods
  list_mods: Command<void, ModSnapshot>;
  prepare_mod_install: Command<{ path: string }, PreparedMod>;
  discard_mod_install: Command<{ ticket: string }, void>;
  install_mod: Command<{ ticket: string }, void>;
  set_mod_enabled: Command<{ id: string; enabled: boolean }, void>;
  remove_mod: Command<{ id: string; keepPreferences: boolean }, void>;
  mod_action: Command<{ id: string; action: string; value: unknown }, void>;
  mod_connection_status: Command<{ id: string; connection: string }, boolean>;
  connect_mod: Command<{ id: string; connection: string; clientId: string }, void>;
  disconnect_mod: Command<{ id: string; connection: string }, void>;

  // Rust has these and the preview fakes them, but no wrapper calls them today.
  get_drafts: Command<Account, DraftSummary[]>;
  /** Sync one account now, or every account when `accountId` is omitted. */
  sync_now: Command<{ accountId?: string | null }, void>;

  // Settings and support
  list_theme_folder: Command<void, { path: string; files: ThemeFolderFile[] }>;
  open_theme_folder: Command<void, void>;
  clear_downloaded_mail: Command<void, ClearedDownloads>;
  send_diagnostics: Command<
    { note: string; replyTo: string | null; email?: DiagnosticsEmail; screenshots?: string[] },
    void
  >;
  save_diagnostics: Command<
    {
      note: string;
      replyTo: string | null;
      path: string;
      email?: DiagnosticsEmail;
      screenshots?: string[];
    },
    void
  >;
  prepare_screenshot: Command<{ data: string } | { path: string }, PreparedScreenshot>;
  log_update: Command<{ event: UpdateEvent; version: string | null; error: string | null }, void>;
  start_hidden_next_launch: Command<void, void>;
  launch_hidden: Command<void, boolean>;
  log_thread_shown: Command<{ timing: ShownTiming }, void>;
  log_preview: Command<{ report: PreviewReport }, void>;
  log_window_problem: Command<{ problem: WindowProblem }, void>;
  telemetry_enabled: Command<void, boolean>;
  set_telemetry: Command<{ enabled: boolean }, boolean>;
  record_usage: Command<{ batch: UsageBatch }, void>;
}
