import { Keyboard } from "lucide-react";
import { registry } from "../../keyboard/registry";
import { commandMatches, KeyboardSettings, ResetAllShortcuts } from "../KeyboardSettings";
import type { SettingsPageDef } from "../schema";

export const KEYBOARD_PAGE: SettingsPageDef = {
  id: "keyboard",
  title: "Keyboard shortcuts",
  icon: Keyboard,
  keywords: ["keybindings", "hotkeys", "keys"],
  Component: KeyboardSettings,
  matches: (query) => registry.list().some((c) => commandMatches(c, query)),
  HeaderAction: ResetAllShortcuts,
};
