import { Contact, Filter, LayoutList, SquarePen, Users } from "lucide-react";
import {
  type DefaultReply,
  UNDO_SEND_CHOICES,
  type UndoSendSeconds,
  useComposeSettings,
} from "../../compose/composeSettings";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Switch } from "../../components/ui/Switch";
import { AccountsSettings, accountsMatch } from "../AccountsSettings";
import { ClearDownloadedMail } from "../ClearDownloadedMail";
import { ContactsSettings } from "../ContactsSettings";
import { GmailQuotaControl } from "../GmailQuotaControl";
import { InboxTabsSettings } from "../InboxTabsSettings";
import { MailStatsLink } from "../MailStatsLink";
import type { SettingsPageDef } from "../schema";
import { SenderRulesSettings } from "../SenderRulesSettings";
import { SignatureSettings } from "../SignatureSettings";
import { FiltersSettings } from "../../filters/FiltersSettings";

function DefaultReplyControl() {
  const reply = useComposeSettings((s) => s.defaultReply);
  const set = useComposeSettings((s) => s.setDefaultReply);
  return (
    <SegmentedControl
      label="Default reply"
      value={reply}
      options={[
        { value: "reply", label: "Reply" },
        { value: "replyAll", label: "Reply all" },
      ]}
      onChange={(v) => set(v as DefaultReply)}
    />
  );
}

function ConfirmSendControl() {
  const confirm = useComposeSettings((s) => s.confirmSend);
  const set = useComposeSettings((s) => s.setConfirmSend);
  return <Switch label="Confirm before sending" checked={confirm} onChange={set} />;
}

function UndoSendControl() {
  const seconds = useComposeSettings((s) => s.undoSendSeconds);
  const set = useComposeSettings((s) => s.setUndoSendSeconds);
  return (
    <SegmentedControl
      label="Undo send"
      value={String(seconds)}
      options={UNDO_SEND_CHOICES.map((n) => ({
        value: String(n),
        label: n === 0 ? "Off" : `${n} s`,
      }))}
      onChange={(v) => set(Number(v) as UndoSendSeconds)}
    />
  );
}

export const ACCOUNTS_PAGE: SettingsPageDef = {
  id: "accounts",
  title: "Accounts",
  icon: Users,
  group: "Mail",
  keywords: [
    "gmail",
    "google",
    "sign in",
    "sign out",
    "remove",
    "add",
    "transfer",
    "credentials",
    "local network",
    "sync",
    "progress",
    "download",
    "offline",
    "quota",
    "rate limit",
    "usage",
  ],
  sections: [
    { id: "accounts", Component: AccountsSettings, matches: accountsMatch },
    {
      title: "Sync",
      settings: [
        {
          id: "sync.gmailQuota",
          title: "Gmail API limit",
          description:
            "Units per minute per user, as shown under Google Cloud Console › Gmail API › Quotas. If you raise it there, enter the new limit here. Pheeme uses up to 80% of it and downloads older mail with at most 40%, so new mail and sending stay quick.",
          keywords: ["throttle", "rate limited", "units per minute", "slow"],
          Control: GmailQuotaControl,
        },
        {
          id: "privacy.clearDownloaded",
          title: "Clear downloaded mail",
          description:
            "Remove the email text and attachments saved on this computer. Your conversation list and labels stay, and an email downloads again when you open it.",
          keywords: ["privacy", "cache", "local", "delete", "storage", "disk", "attachments"],
          Control: ClearDownloadedMail,
        },
      ],
    },
  ],
};

export const INBOX_PAGE: SettingsPageDef = {
  id: "inbox",
  title: "Inbox",
  icon: LayoutList,
  group: "Mail",
  keywords: ["categories", "tabs", "primary", "social", "promotions", "updates", "forums"],
  sections: [
    { id: "inboxTabs", Component: InboxTabsSettings, matches: accountsMatch },
    {
      id: "senderRules",
      Component: SenderRulesSettings,
      keywords: ["sender rules", "filters", "future mail", "sender"],
      matches: accountsMatch,
    },
    {
      id: "mailStats",
      Component: MailStatsLink,
      keywords: [
        "mail stats",
        "statistics",
        "insights",
        "how much mail",
        "per day",
        "received",
        "opened",
        "replied",
        "starred",
        "engagement",
        "senders",
        "unsubscribe",
        "newsletters",
        "labels",
      ],
    },
  ],
};

export const COMPOSE_PAGE: SettingsPageDef = {
  id: "compose",
  title: "Compose",
  icon: SquarePen,
  group: "Mail",
  keywords: ["write", "send", "reply", "draft"],
  sections: [
    {
      title: "Replies",
      settings: [
        {
          id: "compose.defaultReply",
          title: "Default reply",
          description: "Which reply button comes first, and stands out, above a conversation.",
          keywords: ["reply all", "button", "toolbar"],
          Control: DefaultReplyControl,
        },
      ],
    },
    {
      title: "Sending",
      settings: [
        {
          id: "compose.undoSend",
          title: "Undo send",
          description: "How long a sent message waits, so you can take it back.",
          keywords: ["delay", "cancel", "unsend"],
          Control: UndoSendControl,
        },
        {
          id: "compose.confirmSend",
          title: "Confirm before sending",
          description: "Ask before each message leaves, in addition to Undo send.",
          keywords: ["prompt", "ask", "send", "accidental"],
          Control: ConfirmSendControl,
        },
      ],
    },
    {
      id: "signatures",
      Component: SignatureSettings,
      keywords: ["signatures", "sign off", "footer", "forward", "new message"],
      matches: accountsMatch,
    },
  ],
};

export const CONTACTS_PAGE: SettingsPageDef = {
  id: "contacts",
  title: "Contacts",
  icon: Contact,
  group: "Mail",
  keywords: [
    "autocomplete",
    "suggestions",
    "recipients",
    "to",
    "google contacts",
    "people api",
    "address book",
  ],
  Component: ContactsSettings,
};

export const FILTERS_PAGE: SettingsPageDef = {
  id: "filters",
  title: "Filters",
  icon: Filter,
  group: "Mail",
  keywords: [
    "rules",
    "filter messages like these",
    "skip the inbox",
    "auto label",
    "forward",
    "delete",
    "never spam",
    "important",
    "categorize",
  ],
  sections: [{ id: "filters", Component: FiltersSettings, matches: accountsMatch }],
};
