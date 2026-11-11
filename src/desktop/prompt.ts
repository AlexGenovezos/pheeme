import { useEffect } from "react";
import { create } from "zustand";
import { toast } from "../components/ui/Toast";
import { toCommandError } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { answerNotificationPrompt, getDesktopSettings } from "./api";

/**
 * The first-run offer to turn on new-mail notifications. It waits in the sidebar
 * (`NotificationOffer`) rather than floating over the app, so it never covers anything.
 */
export const useNotificationOffer = create<{ offer: string | null }>(() => ({ offer: null }));

/** Answer the offer: turn notifications on, or not now (either way, it isn't asked again). */
export async function answerNotificationOffer(enable: boolean) {
  useNotificationOffer.setState({ offer: null });
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
    getDesktopSettings()
      .then((settings) => {
        const unasked = settings.accounts.filter((a) => !a.asked);
        if (stopped || unasked.length === 0) return;
        useNotificationOffer.setState({
          offer:
            unasked.length === 1
              ? `Get an alert when new Primary mail arrives for ${unasked[0].email}.`
              : "Get an alert when new Primary mail arrives in your accounts.",
        });
      })
      // Includes a malformed reply, so a failure here never surfaces as an unhandled rejection.
      .catch((error) => console.warn("Could not read notification settings", error));
    return () => {
      stopped = true;
    };
  }, [accountIds]);
}

/** Withdraw the offer without answering it (Settings answered instead). */
export function resetNotificationPrompt() {
  useNotificationOffer.setState({ offer: null });
}
