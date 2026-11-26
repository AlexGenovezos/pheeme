import { useState } from "react";
import { TextInput } from "../../components/ui/TextInput";
import { parseClientJson } from "../clientJson";
import { Footer } from "./Footer";

const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

export function Credentials({
  clientId,
  clientSecret,
  onChange,
  onSubmit,
  onGuide,
  onBack,
}: {
  clientId: string;
  clientSecret: string;
  onChange: (clientId: string, clientSecret: string) => void;
  onSubmit: () => void;
  onGuide?: () => void;
  onBack?: () => void;
}) {
  const [jsonError, setJsonError] = useState("");
  const id = clientId.trim();
  const idProblem =
    id && !id.endsWith(CLIENT_ID_SUFFIX) ? `A client ID ends in ${CLIENT_ID_SUFFIX}.` : "";
  const ready = id.endsWith(CLIENT_ID_SUFFIX) && clientSecret.trim() !== "";

  function onIdInput(text: string) {
    const parsed = parseClientJson(text);
    if (parsed === null) {
      setJsonError("");
      onChange(text, clientSecret);
    } else if (parsed.ok) {
      setJsonError("");
      onChange(parsed.clientId, parsed.clientSecret);
    } else {
      setJsonError(parsed.reason);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit();
      }}
    >
      <h1>Paste your client ID and secret</h1>
      <p className="guide-lead">
        Copy both from the dialog Google showed when you created the Desktop app client. You can
        also paste the downloaded JSON file's contents into the first box.
      </p>
      <div className="field">
        <label htmlFor="client-id">Client ID</label>
        <TextInput
          id="client-id"
          size="lg"
          value={clientId}
          onChange={(event) => onIdInput(event.target.value)}
          placeholder={`1234-abcd${CLIENT_ID_SUFFIX}`}
          autoFocus
          invalid={Boolean(idProblem || jsonError)}
        />
        {(jsonError || idProblem) && (
          <small className="field__error">{jsonError || idProblem}</small>
        )}
      </div>
      <div className="field">
        <label htmlFor="client-secret">Client secret</label>
        <TextInput
          id="client-secret"
          size="lg"
          type="password"
          value={clientSecret}
          onChange={(event) => onChange(clientId, event.target.value)}
        />
        <small className="field__hint">
          Stored in your system keychain, never in Pheeme's database.
        </small>
      </div>
      {onGuide && (
        <p className="guide-why">
          No client yet?{" "}
          <button type="button" className="link" onClick={onGuide}>
            Follow the setup guide
          </button>
        </p>
      )}
      <Footer
        onBack={onBack}
        primary={{ label: "Next", onClick: onSubmit, disabled: !ready, submit: true }}
      />
    </form>
  );
}
