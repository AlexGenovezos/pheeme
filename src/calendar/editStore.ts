// Calendar editing state, apart from the view's: the new event being placed (quick create), the
// open editor, the question a save is waiting on, an event being dragged or saved somewhere new,
// events hidden while their delete is under way, and calendar search.
import { create } from "zustand";
import type { CalendarEvent, EventDetail, EventTime } from "../lib/tauri";
import type { EventForm } from "./eventForm";

/** The id the new, unsaved event draws with. */
export const DRAFT_ID = "__draft__";

export interface Draft {
  form: EventForm;
  /** `dragging` while the user is still sweeping out its time on the grid. */
  phase: "dragging" | "ready";
}

export interface EditorSpec {
  form: EventForm;
  /** The form as it opened, for an existing event: a save sends only what changed. */
  initial: EventForm | null;
  /** The event being changed (null when creating). */
  event: CalendarEvent | null;
  detail: EventDetail | null;
}

export interface PromptOption {
  value: string;
  label: string;
}
export interface PromptSpec {
  title: string;
  message?: string;
  /** `choice`: radio list with OK, like the website's repeating-event question. `buttons`: one button each. */
  kind: "choice" | "buttons";
  options: PromptOption[];
  resolve(value: string | null): void;
}

/** Where an event draws while it's dragged, or while its new place is being saved. */
export interface Moving {
  key: string;
  start: EventTime;
  end: EventTime;
}

interface EditState {
  draft: Draft | null;
  editor: EditorSpec | null;
  prompt: PromptSpec | null;
  moving: Moving | null;
  /** Keys of events hidden while their delete is under way. */
  removed: string[];
  /** Calendar search is showing, with what's typed. */
  search: string | null;
}

export const useEditStore = create<EditState>(() => ({
  draft: null,
  editor: null,
  prompt: null,
  moving: null,
  removed: [],
  search: null,
}));

/** Ask the user, and wait for the answer (null: they backed out). */
export function ask(spec: Omit<PromptSpec, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    useEditStore.getState().prompt?.resolve(null);
    useEditStore.setState({
      prompt: {
        ...spec,
        resolve: (value) => {
          useEditStore.setState({ prompt: null });
          resolve(value);
        },
      },
    });
  });
}
