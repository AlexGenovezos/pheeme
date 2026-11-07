import { useEffect } from "react";
import { dismissToast, toast, useToastStore } from "../components/ui/Toast";
import { toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { answerNotificationPrompt, getDesktopSettings } from "./api";

let shown: number | null = null;
// A newer toast can push the prompt out of the stack; then it may be offered again.
const showing = () => shown !== null && useToastStore.getState().toasts.some((t) => t.id === shown);

async function answer(enable: boolean) {
  try {
    await answerNotificationPrompt(enable);
    if (enable)
      toast({ title: "Notifications are on", description: "Change them any time in Settings." });
  } catch (raw) {
    toast({ title: toCommandError(raw).message, tone: "danger", duration: 0 });
  }
}

/** Offer new-mail notifications once for each account that hasn't been asked yet. */
export function useNotificationPrompt() {
  const accountIds = useAccountStore((s) => s.accounts.map((a) => a.id).join("\n"));
  useEffect(() => {
    if (!accountIds) return;
    let stopped = false;
    getDesktopSettings().then(
      (settings) => {
        const unasked = settings.accounts.filter((a) => !a.asked);
        if (stopped || unasked.length === 0 || showing()) return;
        shown = toast({
          title: "Turn on notifications?",
          description:
            unasked.length === 1
              ? `Get an alert when new Primary mail arrives for ${unasked[0].email}.`
              : "Get an alert when new Primary mail arrives in your accounts.",
          duration: 0,
          action: {
            label: "Turn on",
            run: () => {
              shown = null;
              void answer(true);
            },
          },
          onDismiss: () => {
            shown = null;
            void answer(false);
          },
        });
      },
      (error) => console.warn("Could not read notification settings", error),
    );
    return () => {
      stopped = true;
    };
  }, [accountIds]);
}

/** Test hook: forget the visible prompt. */
export function resetNotificationPrompt() {
  if (shown !== null) dismissToast(shown);
  shown = null;
}
