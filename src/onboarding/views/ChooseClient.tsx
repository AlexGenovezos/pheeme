import type { AccountInfo } from "../../lib/tauri";

export function ChooseClient({
  accounts,
  onReuse,
  onNew,
}: {
  accounts: AccountInfo[];
  onReuse: (accountId: string) => void;
  onNew: () => void;
}) {
  // One option per distinct OAuth client, labelled by the first account using it.
  const byClient = new Map<string, AccountInfo>();
  for (const account of accounts)
    if (!byClient.has(account.clientId)) byClient.set(account.clientId, account);
  return (
    <>
      <h1>Add an account</h1>
      <p className="guide-lead">
        Another Google account can sign in through the Google Cloud app you already set up. A work
        account whose administrator requires its own OAuth client needs a different one.
      </p>
      <div className="choice-list">
        {[...byClient.values()].map((account) => (
          <button
            key={account.clientId}
            type="button"
            className="choice"
            onClick={() => onReuse(account.id)}
          >
            <strong>Use the same Google Cloud app</strong>
            <span>The one {account.email} signed in with</span>
          </button>
        ))}
        <button type="button" className="choice" onClick={onNew}>
          <strong>Use a different OAuth client</strong>
          <span>Paste another client ID and secret</span>
        </button>
      </div>
    </>
  );
}
