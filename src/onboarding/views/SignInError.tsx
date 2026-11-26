import { Button } from "../../components/ui/Button";
import type { CommandError } from "../../lib/tauri";
import { isCredentialProblem, problemTitle } from "../troubleshooting";

export function SignInError({
  error,
  onRetry,
  onFixCredentials,
}: {
  error: CommandError;
  onRetry?: () => void;
  onFixCredentials?: () => void;
}) {
  const credentialsFirst = isCredentialProblem(error.code) && onFixCredentials;
  return (
    <div role="alert">
      <h1>{problemTitle(error.code)}</h1>
      <p className="guide-lead">{error.message}</p>
      <div className="onboarding-footer">
        {credentialsFirst ? (
          <>
            {onRetry ? (
              <Button variant="ghost" size="lg" onClick={onRetry}>
                Try again
              </Button>
            ) : (
              <span />
            )}
            <Button variant="primary" size="lg" onClick={onFixCredentials}>
              Change client ID or secret
            </Button>
          </>
        ) : (
          <>
            {onFixCredentials ? (
              <Button variant="ghost" size="lg" onClick={onFixCredentials}>
                Change client ID or secret
              </Button>
            ) : (
              <span />
            )}
            {onRetry && (
              <Button variant="primary" size="lg" onClick={onRetry}>
                Try again
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
