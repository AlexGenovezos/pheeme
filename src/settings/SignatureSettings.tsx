// Settings › Compose › Signature: for each account, its Gmail signature (fetched when the page opens), its own signature,
// and which of them new messages and replies/forwards start with.
import { lazy, type MouseEvent, Suspense, useEffect, useMemo } from "react";
import { Button } from "../components/ui/Button";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Skeleton } from "../components/ui/Skeleton";
import {
  type AccountSignatures,
  cleanSignature,
  type GmailSignature,
  hasContent,
  type SignatureChoice,
  useSignatures,
} from "../compose/signatures";
import { openLink } from "../mail/linkify";
import { ReconnectButton } from "../onboarding/Reconnect";
import { useAccountStore } from "../store/accountStore";
import { accountSectionTitle, SettingsRow, SettingsSection } from "./rows";

const SignatureEditor = lazy(() => import("../compose/SignatureEditor"));

const CHOICES: { value: SignatureChoice; label: string }[] = [
  { value: "gmail", label: "Gmail's" },
  { value: "custom", label: "Your own" },
  { value: "none", label: "None" },
];

/** A link clicked in the preview opens in the browser; one that isn't a whole web or mail address goes nowhere. */
function openSignatureLink(e: MouseEvent<HTMLDivElement>) {
  const link = (e.target as Element).closest("a[href]");
  if (!link) return;
  e.preventDefault(); // never a navigation of the app's own window
  try {
    const url = new URL(link.getAttribute("href") ?? "");
    if (["http:", "https:", "mailto:"].includes(url.protocol)) openLink(url.href);
  } catch {
    // Relative: nothing to open.
  }
}

/** A signature as it will look in a message. */
function SignaturePreview({ html }: { html: string }) {
  const clean = useMemo(() => cleanSignature(html), [html]);
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the links inside are what's clicked
    <div
      className="signature-preview"
      onClick={openSignatureLink}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

function GmailRow({ accountId, gmail }: { accountId: string; gmail: GmailSignature | undefined }) {
  const refresh = () => void useSignatures.getState().refreshGmail(accountId);
  const error = gmail?.error;
  if (error?.code === "missing_scope")
    return (
      <SettingsRow
        title="Gmail signature"
        description="Pheeme can't see this account's Gmail settings. Sign in again and allow Pheeme to manage your basic mail settings."
        control={<ReconnectButton accountId={accountId} />}
      />
    );
  const html = gmail?.html;
  let description;
  if (html === undefined && !error) description = <Skeleton width="60%" />;
  else if (hasContent(html)) description = <SignaturePreview html={html} />;
  else if (html === null)
    description = "None set in Gmail. Add one under Gmail › Settings › Signature.";
  else description = `Couldn't load it: ${error?.message}`;
  return (
    <SettingsRow
      className="settings-row--signature"
      title="Gmail signature"
      description={description}
      control={
        <Button size="sm" disabled={gmail?.loading} onClick={refresh}>
          {gmail?.loading ? "Checking…" : error ? "Try again" : "Check again"}
        </Button>
      }
    />
  );
}

function AccountSignatures({
  accountId,
  email,
  title,
}: {
  accountId: string;
  email: string;
  title: string;
}) {
  const prefs = useSignatures((s) => s.forAccount(accountId));
  const gmail = useSignatures((s) => s.gmail[accountId]);
  const update = (change: Partial<AccountSignatures>) =>
    useSignatures.getState().update(accountId, change);

  useEffect(() => {
    void useSignatures.getState().refreshGmail(accountId);
  }, [accountId]);

  return (
    <SettingsSection title={title}>
      <GmailRow accountId={accountId} gmail={gmail} />
      <div className="settings-row settings-row--stacked">
        <div className="settings-row__text">
          <div className="settings-row__title">Your own signature</div>
          <div className="settings-row__description">
            Used instead of Gmail's wherever you choose “Your own” below.
          </div>
        </div>
        <Suspense fallback={<div className="signature-editor" aria-hidden="true" />}>
          <SignatureEditor
            html={prefs.custom}
            label={`Your own signature for ${email}`}
            onChange={(custom) => update({ custom })}
          />
        </Suspense>
      </div>
      <SettingsRow
        title="New messages"
        control={
          <SegmentedControl
            label={`Signature for new messages from ${email}`}
            value={prefs.newMessages}
            options={CHOICES}
            onChange={(newMessages) => update({ newMessages })}
          />
        }
      />
      <SettingsRow
        title="Replies and forwards"
        description="Goes above the quoted message."
        control={
          <SegmentedControl
            label={`Signature for replies and forwards from ${email}`}
            value={prefs.replies}
            options={CHOICES}
            onChange={(replies) => update({ replies })}
          />
        }
      />
    </SettingsSection>
  );
}

export function SignatureSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  if (accounts.length === 0)
    return (
      <SettingsSection title="Signature">
        <SettingsRow title="Connect an account to choose its signature" />
      </SettingsSection>
    );
  return (
    <>
      {accounts.map((a) => (
        <AccountSignatures
          key={a.id}
          accountId={a.id}
          email={a.email}
          title={accountSectionTitle("Signature", a.email, accounts.length)}
        />
      ))}
    </>
  );
}
