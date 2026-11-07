/** Label create/edit/delete for browser preview, with the backend's checks and cascades (`src-tauri/src/labels.rs`). */

import { emit } from "@tauri-apps/api/event";
import { isAllowedColor } from "../labels/palette";
import { type LabelInfo, SYNC_EVENTS, type SyncMessagesUpdated } from "../lib/tauri";
import { fixtureUserLabels, type FixtureThread, SYSTEM_LABELS } from "./fixtures";

type Args = Record<string, unknown> | undefined;

/** A user label as the preview keeps it; mutable, one set per preview backend. */
export interface PreviewLabel {
  id: string;
  accountId: string;
  name: string;
  colorBackground: string | null;
  colorText: string | null;
  labelListVisibility: string;
  messageListVisibility: string;
}

const LABEL_LIST = ["labelShow", "labelShowIfUnread", "labelHide"];
const MESSAGE_LIST = ["show", "hide"];

export function createPreviewLabels(): PreviewLabel[] {
  return fixtureUserLabels.map((l) => ({
    id: l.id,
    accountId: l.accountId,
    name: l.name,
    colorBackground: l.color ?? null,
    colorText: null,
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  }));
}

/** The account's system labels and user labels, shaped like `list_labels`. */
export function labelsFor(labels: PreviewLabel[], accountId: string): LabelInfo[] {
  const counters = { messagesTotal: 0, messagesUnread: 0, threadsTotal: 0, threadsUnread: 0 };
  return [
    ...SYSTEM_LABELS.map((l) => ({
      ...counters,
      accountId,
      id: l.id,
      name: l.name,
      type: "system",
      colorBackground: null,
      colorText: null,
      messageListVisibility: "show",
      labelListVisibility: "labelShow",
    })),
    ...labels.filter((l) => l.accountId === accountId).map((l) => toInfo(l)),
  ];
}

function toInfo(l: PreviewLabel): LabelInfo {
  return {
    messagesTotal: 0,
    messagesUnread: 0,
    threadsTotal: 0,
    threadsUnread: 0,
    type: "user",
    ...l,
  };
}

const invalid = (message: string) => ({ code: "invalid_input", message });
const duplicate = (name: string) => invalid(`A label named "${name}" already exists.`);

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (!name) throw invalid("Enter a name for the label.");
  if (name.split("/").some((part) => !part.trim()))
    throw invalid(
      'A label name can\'t start or end with "/" or have an empty part between two "/".',
    );
  return name;
}

/** Gmail only accepts colours from its palette, for the background and the text. */
function colourOf(value: unknown): { background: string; text: string } | null {
  if (value == null) return null;
  const c = value as { background?: unknown; text?: unknown };
  const ok = (v: unknown) => typeof v === "string" && isAllowedColor(v);
  if (!ok(c.background) || !ok(c.text)) throw invalid("Pick a colour from Gmail's label palette.");
  return { background: String(c.background), text: String(c.text) };
}

function checkVisibility(value: unknown, allowed: string[]): string | undefined {
  if (value == null) return undefined;
  if (!allowed.includes(String(value)))
    throw invalid(`Gmail doesn't have a "${String(value)}" visibility.`);
  return String(value);
}

const notify = (event: string, payload: unknown) =>
  // Fire and forget: the IPC mock isn't there when a test calls a handler directly.
  void emit(event, payload).catch(() => {});

export function createLabelHandlers(
  labels: PreviewLabel[],
  threads: FixtureThread[],
): Record<string, (args: Args) => unknown> {
  let nextId = 100;
  const isTaken = (accountId: string, name: string, except: string[]) =>
    labelsFor(labels, accountId).some(
      (l) => !except.includes(l.id) && l.name.toLowerCase() === name.toLowerCase(),
    );
  const sublabelsOf = (label: PreviewLabel) =>
    labels
      .filter((l) => l.accountId === label.accountId && l.name.startsWith(`${label.name}/`))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const userLabel = (args: Args): PreviewLabel => {
    const accountId = String(args?.accountId);
    const label = labels.find((l) => l.accountId === accountId && l.id === args?.labelId);
    if (label) return label;
    if (SYSTEM_LABELS.some((l) => l.id === args?.labelId))
      throw invalid("Gmail's own labels can't be changed.");
    throw { code: "not_found", message: "That label isn't available any more." };
  };
  const labelsUpdated = (accountId: string) => notify(SYNC_EVENTS.labelsUpdated, { accountId });

  return {
    create_label: (args) => {
      const accountId = String(args?.accountId);
      const name = cleanName(args?.name);
      const colour = colourOf(args?.color);
      if (isTaken(accountId, name, [])) throw duplicate(name);
      while (labels.some((l) => l.id === `Label_${nextId}`)) nextId += 1;
      const label: PreviewLabel = {
        id: `Label_${nextId}`,
        accountId,
        name,
        colorBackground: colour?.background ?? null,
        colorText: colour?.text ?? null,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      };
      labels.push(label);
      labelsUpdated(accountId);
      return toInfo(label);
    },
    update_label: (args) => {
      const label = userLabel(args);
      const edit = (args?.edit ?? {}) as Record<string, unknown>;
      const labelList = checkVisibility(edit.labelListVisibility, LABEL_LIST);
      const messageList = checkVisibility(edit.messageListVisibility, MESSAGE_LIST);
      if (edit.clearColor === true && edit.color != null)
        throw invalid("Choose a colour or remove it, not both.");
      const colour = colourOf(edit.color);
      const renames: [PreviewLabel, string][] = [];
      if (edit.name != null) {
        const name = cleanName(edit.name);
        if (name !== label.name) {
          if (name.toLowerCase().startsWith(`${label.name.toLowerCase()}/`))
            throw invalid("A label can't be nested under itself or one of its sublabels.");
          renames.push([label, name]);
          for (const sub of sublabelsOf(label))
            renames.push([sub, name + sub.name.slice(label.name.length)]);
          const moving = renames.map(([l]) => l.id);
          const clash = renames.find(([, n]) => isTaken(label.accountId, n, moving));
          if (clash) throw duplicate(clash[1]);
        }
      }
      if (!renames.length && !colour && edit.clearColor !== true && !labelList && !messageList)
        return [toInfo(label)];
      for (const [l, name] of renames) l.name = name;
      if (colour) {
        label.colorBackground = colour.background;
        label.colorText = colour.text;
      }
      if (edit.clearColor === true) {
        label.colorBackground = null;
        label.colorText = null;
      }
      if (labelList) label.labelListVisibility = labelList;
      if (messageList) label.messageListVisibility = messageList;
      labelsUpdated(label.accountId);
      return (renames.length ? renames.map(([l]) => l) : [label]).map(toInfo);
    },
    delete_label: (args) => {
      const label = userLabel(args);
      const gone = new Set([label, ...sublabelsOf(label)].map((l) => l.id));
      const changed = threads.filter(
        (t) => t.accountId === label.accountId && t.labelIds.some((id) => gone.has(id)),
      );
      for (const t of changed) t.labelIds = t.labelIds.filter((id) => !gone.has(id));
      for (let i = labels.length - 1; i >= 0; i -= 1)
        if (labels[i].accountId === label.accountId && gone.has(labels[i].id)) labels.splice(i, 1);
      if (changed.length) {
        const payload: SyncMessagesUpdated = {
          accountId: label.accountId,
          added: [],
          removed: [],
          modified: changed.map((t) => t.id),
        };
        notify(SYNC_EVENTS.messagesUpdated, payload);
      }
      labelsUpdated(label.accountId);
    },
    delete_label_preview: (args) => {
      const label = userLabel(args);
      return {
        threads: threads.filter(
          (t) => t.accountId === label.accountId && t.labelIds.includes(label.id),
        ).length,
        sublabels: sublabelsOf(label).map((l) => l.name),
      };
    },
  };
}
