import { invoke } from "@tauri-apps/api/core";

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
}
export interface EventTarget {
  accountId: string;
  calendarId: string;
  eventId: string;
}
/** What a clicked notification opens: new mail's conversation, or a reminder's event. */
export type NotifyTarget = ({ kind: "thread" } & ThreadTarget) | ({ kind: "event" } & EventTarget);
export const getDesktopSettings = () => invoke<DesktopSettings>("desktop_settings");
export const setAccountNotifications = (accountId: string, enabled: boolean) =>
  invoke<DesktopSettings>("set_account_notifications", { accountId, enabled });
export const answerNotificationPrompt = (enable: boolean) =>
  invoke<DesktopSettings>("answer_notification_prompt", { enable });
export const setTrayIcon = (shown: boolean) => invoke<DesktopSettings>("set_tray_icon", { shown });
export const takeNotificationTarget = () => invoke<NotifyTarget | null>("take_notification_target");
export const setCalendarReminders = (enabled: boolean) =>
  invoke<DesktopSettings>("set_calendar_reminders", { enabled });
export const setNotificationSchedule = (schedule: NotifySchedule) =>
  invoke<DesktopSettings>("set_notification_schedule", { schedule });
