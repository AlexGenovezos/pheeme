// The open filter editor, if any: a new filter (blank, or prefilled by Filter messages like these)
// or an existing one being changed.
import { create } from "zustand";
import type { FilterEntry, FilterSpec } from "../lib/tauri";

export interface FilterEditorSpec {
  accountId: string;
  /** The filter being changed; absent for a new one. */
  filterId?: string;
  /** What the form opens on. */
  spec?: Partial<FilterSpec>;
  /** Told about the saved filter (Settings › Filters updates its list). */
  onSaved?(entry: FilterEntry, replaced?: string): void;
}

interface FilterEditorStore {
  editor: (FilterEditorSpec & { seq: number }) | null;
  close(): void;
}

let seq = 0;

export const useFilterEditorStore = create<FilterEditorStore>((set) => ({
  editor: null,
  close: () => set({ editor: null }),
}));

export function openFilterEditor(spec: FilterEditorSpec): void {
  useFilterEditorStore.setState({ editor: { ...spec, seq: ++seq } });
}
