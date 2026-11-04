// Types for release-notes.mjs, which the app imports (src/settings/releaseNotes.ts).

export type NotesInline =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type NotesBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; content: NotesInline[] }
  | { type: "list"; items: NotesInline[][] };

export const LINK_HOSTS: string[];
export function stripComments(text: string): string;
export function isNewer(a: string, b: string): boolean;
export function parseNotes(text: string): { blocks: NotesBlock[]; errors: string[] };
