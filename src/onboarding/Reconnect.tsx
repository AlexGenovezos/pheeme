import { Button } from "../components/ui/Button";
import { useSettingsStore } from "../settings/settingsStore";
import { type SyncFailure, useAccountStore } from "../store/accountStore";

/** Google no longer accepts the account's saved sign-in: only signing in again fixes it. */
export const isSignedOut = (failure: SyncFailure | undefined) => failure?.code === "signed_out";

/** Signs the account in again in place, keeping its cached mail. */
export function ReconnectButton({
  accountId,
  className,
}: {
  accountId: string;
  className?: string;
}) {
  return (
    <Button
      size="sm"
      variant="primary"
      className={className}
      onClick={() => {
        // Onboarding replaces the mail screen, so the settings dialog mustn't reopen on return.
        useSettingsStore.getState().close();
        useAccountStore.getState().reconnect(accountId);
      }}
    >
      Sign in again
    </Button>
  );
}
