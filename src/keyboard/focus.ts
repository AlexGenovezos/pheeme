/**
 * Focus `el` for a keyboard move between panes and mark it so its ring shows (`[data-key-focus]:focus`).
 * The browser's own `:focus-visible` guess for script focus is unreliable in WebKit after a mouse click,
 * which left Left from an email looking like it did nothing.
 */
export function focusFromKeyboard(el: HTMLElement | null | undefined, options?: FocusOptions) {
  if (!el) return;
  el.focus(options);
  if (el.ownerDocument.activeElement !== el) return; // hidden or not focusable: nothing to mark
  el.dataset.keyFocus = "";
  el.addEventListener("blur", () => delete el.dataset.keyFocus, { once: true });
}
