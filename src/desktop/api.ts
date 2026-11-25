import { call } from "../lib/ipc/call";

export interface NotificationAccount {
  accountId: string;
  email: string;
  enabled: boolean;
  /** Answered via the prompt or Settings; unanswered accounts get the prompt. */
  asked: boolean;
}
export interface NotifySchedule {
  mode: "always" | "workHours" | "off";
  /** Local hour, 0 to 23. */
  startHour: number;
  endHour: number;
  weekdaysOnly: boolean;
}
export interface DesktopSettings {
  accounts: NotificationAccount[];
  permission: "notDetermined" | "denied" | "granted" | "system";
  /** Closing the window keeps Pheeme running in the tray. */
  trayAvailable: boolean;
  /** The user wants the menu bar / notification area icon. */
  trayEnabled: boolean;
  /** When alerts may appear, for every account. */
  schedule: NotifySchedule;
  /** Event reminders pop up as notifications. */
  calendarReminders: boolean;
}
export interface ThreadTarget {
  accountId: string;
  threadId: string;
  /** The message the notification showed; missing from a notification shown by an older version. */
  messageId?: string | null;
}
export interface EventTarget {
  accountId: string;
  calendarId: string;
  eventId: string;
}
/** What a clicked notification opens: new mail's conversation, or a reminder's event. */
export type NotifyTarget = ({ kind: "thread" } & ThreadTarget) | ({ kind: "event" } & EventTarget);
export const getDesktopSettings = () => call("desktop_settings");
export const setAccountNotifications = (accountId: string, enabled: boolean) =>
  call("set_account_notifications", { accountId, enabled });
export const answerNotificationPrompt = (enable: boolean) =>
  call("answer_notification_prompt", { enable });
export const setTrayIcon = (shown: boolean) => call("set_tray_icon", { shown });
export const takeNotificationTarget = () => call("take_notification_target");
export const setCalendarReminders = (enabled: boolean) =>
  call("set_calendar_reminders", { enabled });
export const setNotificationSchedule = (schedule: NotifySchedule) =>
  call("set_notification_schedule", { schedule });
