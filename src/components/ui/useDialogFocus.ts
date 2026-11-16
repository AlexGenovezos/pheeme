// What every modal dialog shares: keys belong to it while it's open, focus moves in and goes back to
// whatever opened it, and Tab stays inside. Modal uses all of it; Settings and the speed reader have
// key handling of their own and use the same pieces.
import { type KeyboardEvent, type RefObject, useEffect, useState } from "react";
import { registry } from "../../keyboard/registry";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside `dialog`: Tab on its last control goes to the first, Shift+Tab on its first (or
 * on the dialog itself) to the last. Does nothing for other keys.
 */
export function trapTab(e: KeyboardEvent, dialog: HTMLElement | null) {
  if (e.key !== "Tab") return;
  // A roving-tabindex button (tabindex="-1") or one inside a hidden or inert part matches FOCUSABLE
  // but Tab never lands on it, so it can't count as the first or last stop.
  const items = [...(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
    (el) => el.tabIndex >= 0 && !el.closest("[hidden], [inert]"),
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dialog)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export interface DialogFocusOptions {
  /** Where focus goes when it closes, if not the element focused when it opened. */
  returnTo?: HTMLElement | null;
  /** Focus the dialog's `[data-autofocus]` control, if it has one, rather than the dialog (default). */
  autofocus?: boolean;
}

/** Suspends the app's shortcuts while the dialog is open, focuses it, and returns focus on closing. */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  { returnTo, autofocus = true }: DialogFocusOptions = {},
) {
  const [returnFocus] = useState(() => {
    const opener = document.activeElement as HTMLElement | null;
    // A closing picker's own field is about to unmount: prefer what it saved, if it's still on the page.
    return returnTo?.isConnected ? returnTo : opener?.isConnected ? opener : null;
  });

  // While the dialog is open, keys belong to it.
  useEffect(() => registry.suspend(), []);
  useEffect(() => {
    const first = autofocus ? ref.current?.querySelector<HTMLElement>("[data-autofocus]") : null;
    (first ?? ref.current)?.focus();
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [ref, autofocus, returnFocus]);
}
