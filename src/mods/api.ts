import { invoke } from "@tauri-apps/api/core";

export interface ModConnection {
  id: string;
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  apiOrigins: string[];
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  entry: string;
  description: string;
  commands: { id: string; title: string; shortcut: string | null }[];
  permissions: { network: string[]; connections: ModConnection[] };
}

export type ModBlock =
  | { type: "text"; text: string }
  | { type: "button"; id: string; label: string; disabled: boolean }
  | { type: "toggle"; id: string; label: string; value: boolean }
  | { type: "input"; id: string; label: string; value: string };

export interface ModInfo {
  manifest: ModManifest;
  enabled: boolean;
  running: boolean;
  error: string | null;
  views: { settings: ModBlock[]; panel: ModBlock[]; compact: ModBlock[] };
}

export interface ModSnapshot {
  safeMode: boolean;
  mods: ModInfo[];
}
export interface PreparedMod {
  ticket: string;
  manifest: ModManifest;
  replacing: boolean;
}

export const listMods = () => invoke<ModSnapshot>("list_mods");
export const prepareMod = (path: string) => invoke<PreparedMod>("prepare_mod_install", { path });
export const discardMod = (ticket: string) => invoke<void>("discard_mod_install", { ticket });
export const installMod = (ticket: string) => invoke<void>("install_mod", { ticket });
export const setModEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_mod_enabled", { id, enabled });
export const removeMod = (id: string, keepPreferences: boolean) =>
  invoke<void>("remove_mod", { id, keepPreferences });
export const modAction = (id: string, action: string, value: unknown = null) =>
  invoke<void>("mod_action", { id, action, value });
export const connectionStatus = (id: string, connection: string) =>
  invoke<boolean>("mod_connection_status", { id, connection });
export const connectMod = (id: string, connection: string, clientId: string) =>
  invoke<void>("connect_mod", { id, connection, clientId });
export const disconnectMod = (id: string, connection: string) =>
  invoke<void>("disconnect_mod", { id, connection });
