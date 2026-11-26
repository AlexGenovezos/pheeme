// The frontend's whole IPC surface in one import. Each domain lives in src/lib/ipc/ (wrappers around
// `call`, whose names, arguments and results come from the `Commands` map in ipc/commands.ts);
// the per-feature api.ts files (contacts, drive, desktop, transfer, mods) use `call` the same way.
export { type CommandError, toCommandError } from "./ipc/call";
export * from "./ipc/accounts";
export * from "./ipc/assistants";
export * from "./ipc/calendar";
export * from "./ipc/calendarEvents";
export * from "./ipc/compose";
export * from "./ipc/contacts";
export * from "./ipc/events";
export * from "./ipc/labels";
export * from "./ipc/mail";
export * from "./ipc/search";
export * from "./ipc/senderRules";
export * from "./ipc/filters";
export * from "./ipc/settings";
export * from "./ipc/stats";
export * from "./ipc/support";
export * from "./ipc/tasks";
export * from "./ipc/weather";
