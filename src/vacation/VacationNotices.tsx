// While an account's vacation responder is on, a card in the bottom-right corner says so, with
// Gmail's End now, as Gmail's banner does. It draws through `CornerCard`, so nothing moves.
import { useState } from "react";
import { Palmtree } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../components/ui/Button";
import { CornerCard } from "../components/ui/CornerCard";
import { toastError } from "../components/ui/Toast";
import type { VacationResponder } from "../lib/tauri";
import { useAccountStore } from "../store/accountStore";
import { isOn, isWaiting, shortDate } from "./dates";
import { useVacation, useVacationRefresh } from "./vacationStore";

/** What a closed card was showing: it comes back once the responder changes. */
const shownKey = (accountId: string, r: VacationResponder) =>
  JSON.stringify([accountId, r.subject, r.startMs, r.endMs]);

export function VacationNotices() {
  const accounts = useAccountStore((s) => s.accounts);
  useVacationRefresh(accounts.map((a) => a.id));
  const responders = useVacation(
    useShallow((s) => Object.fromEntries(accounts.map((a) => [a.id, s.accounts[a.id]?.value]))),
  );
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [ending, setEnding] = useState<string | null>(null);

  const endNow = async (accountId: string) => {
    setEnding(accountId);
    const error = await useVacation.getState().end(accountId);
    setEnding(null);
    if (error) toastError(error);
  };

  return (
    <>
      {accounts.flatMap((account) => {
        const r = responders[account.id];
        if (!r || !isOn(r)) return [];
        const key = shownKey(account.id, r);
        if (dismissed.includes(key)) return [];
        const until = r.endMs === null ? "Until you end it" : `Until ${shortDate(r.endMs - 1)}`;
        const subject = r.subject.trim() || "No subject";
        return [
          <CornerCard
            waits
            key={key}
            icon={<Palmtree aria-hidden="true" />}
            title={
              isWaiting(r)
                ? `Vacation responder starts ${shortDate(r.startMs!)}`
                : "Vacation responder is on"
            }
            description={
              accounts.length > 1
                ? `${account.email}: “${subject}”. ${until}.`
                : `“${subject}”. ${until}.`
            }
            action={
              <Button
                className="ui-toast__button"
                size="sm"
                disabled={ending === account.id}
                onClick={() => void endNow(account.id)}
              >
                End now
              </Button>
            }
            onDismiss={() => setDismissed((d) => [...d, key])}
          />,
        ];
      })}
    </>
  );
}
