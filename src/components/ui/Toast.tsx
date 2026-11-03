import type { ReactNode } from "react";
import { X } from "lucide-react";
import { create } from "zustand";
import { cx } from "../../lib/utils";
import "./Toast.css";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: "neutral" | "danger";
  action?: { label: string; run(): void };
  /** ms before auto-dismiss; 0 keeps it until dismissed. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastState {
  toasts: ToastItem[];
}

const DEFAULT_DURATION = 4000;
const MAX_VISIBLE = 3;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Show a non-blocking toast. Returns its id. */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  useToastStore.setState((s) => ({ toasts: [...s.toasts, { ...options, id }].slice(-MAX_VISIBLE) }));
  const duration = options.duration ?? DEFAULT_DURATION;
  if (duration > 0) timers.set(id, setTimeout(() => dismissToast(id), duration));
  return id;
}

export function useToast() {
  return { toast, dismiss: dismissToast };
}

function ToastViewport({ pinned }: { pinned?: ReactNode }) {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="ui-toast-viewport" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx("ui-toast", t.tone === "danger" && "ui-toast--danger")}
          role={t.tone === "danger" ? "alert" : "status"}
        >
          <div className="ui-toast__text">
            <span className="ui-toast__title">{t.title}</span>
            {t.description && <span className="ui-toast__description">{t.description}</span>}
          </div>
          {t.action && (
            <button
              type="button"
              className="ui-toast__action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="ui-toast__close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X />
          </button>
        </div>
      ))}
      {pinned}
    </div>
  );
}

/**
 * Renders its children plus the toast stack. Mount once near the root.
 * `pinned` sits at the bottom of the stack and doesn't time out (e.g. the update notice).
 */
export function ToastProvider({ children, pinned }: { children?: ReactNode; pinned?: ReactNode }) {
  return (
    <>
      {children}
      <ToastViewport pinned={pinned} />
    </>
  );
}
