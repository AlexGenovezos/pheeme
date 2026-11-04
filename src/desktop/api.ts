import { invoke } from "@tauri-apps/api/core";

export interface NotificationAccount {
  accountId: string;
  email: string;
  enabled: boolean;
}
export interface DesktopSettings {
  accounts: NotificationAccount[];
  permission: "notDetermined" | "denied" | "granted" | "system";
  trayAvailable: boolean;
}
export interface ThreadTarget {
  accountId: string;
  threadId: string;
}
export const getDesktopSettings = () => invoke<DesktopSettings>("desktop_settings");
export const setAccountNotifications = (accountId: string, enabled: boolean) =>
  invoke<DesktopSettings>("set_account_notifications", { accountId, enabled });
export const takeNotificationTarget = () => invoke<ThreadTarget | null>("take_notification_target");
