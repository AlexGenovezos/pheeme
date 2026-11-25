// What Print (the shortcut, the palette and the More menu) prints: the whole conversation, as Gmail's Print all,
// or only its latest message. Each message's own printer button prints that message whatever this says.
import { create } from "zustand";
import { readItem, writeItem } from "../lib/storage";

export const PRINT_SCOPES = ["conversation", "message"] as const;
export type PrintScope = (typeof PRINT_SCOPES)[number];
const KEY = "pheeme.print-scope";

const read = (): PrintScope => (readItem(KEY) === "message" ? "message" : "conversation");

interface PrintSettings {
  scope: PrintScope;
  setScope(scope: PrintScope): void;
}

export const usePrintSettings = create<PrintSettings>((set) => ({
  scope: read(),
  setScope(scope) {
    writeItem(KEY, scope);
    set({ scope });
  },
}));
