import { Button } from "../../components/ui/Button";
import { openExternal } from "../../lib/tauri";
import { BROWSER_PROBLEMS } from "../troubleshooting";
import { ExternalButton } from "./ExternalButton";
import { useFlash } from "./useFlash";

export function Waiting({
  authUrl,
  email,
  onCancel,
  onFixCredentials,
}: {
  authUrl: string;
  /** Reconnecting: the address to sign in as. */
  email?: string;
  onCancel: () => void;
  onFixCredentials?: () => void;
}) {
  const [copied, flash] = useFlash();
  return (
    <>
      <div className="waiting-mark" aria-hidden />
      <h1>Finish signing in in your browser</h1>
      <p className="guide-lead">
        Pheeme opened Google's sign-in page.{" "}
        {email && (
          <>
            Sign in as <strong>{email}</strong>.{" "}
          </>
        )}
        When it says you can close the tab, come back here.
      </p>
      <div className="button-row">
        <Button
          size="lg"
          disabled={!authUrl}
          onClick={() => void openExternal(authUrl).catch(() => {})}
        >
          Open the browser again
        </Button>
        <Button
          size="lg"
          disabled={!authUrl}
          onClick={() => void navigator.clipboard.writeText(authUrl).then(flash, () => {})}
        >
          {copied ? "Copied" : "Copy sign-in link"}
        </Button>
        <Button variant="ghost" size="lg" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <details className="problems">
        <summary>Seeing an error from Google in the browser?</summary>
        <ul>
          {BROWSER_PROBLEMS.map((problem) => (
            <li key={problem.code}>
              <strong>{problem.title}</strong>
              <p>{problem.fix}</p>
              <div className="button-row">
                {problem.link && (
                  <ExternalButton label={problem.link.label} url={problem.link.url} />
                )}
                {problem.action === "credentials" && onFixCredentials && (
                  <Button size="sm" onClick={onFixCredentials}>
                    Change client ID or secret
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
