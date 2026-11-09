// Settings › MCP: lets MCP clients (Claude Code and others) work with mail through Pheeme's local API while the
// app is open. Off by default; each client connects with its own token, shown once; every tool call is listed
// under Activity with its exact arguments and what came back. See docs/mcp.md.
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { Switch } from "../components/ui/Switch";
import { TextInput } from "../components/ui/TextInput";
import { formatListDate } from "../lib/dates";
import { cx } from "../lib/utils";
import {
  ASSISTANT_ACTIVITY_EVENT,
  type AssistantActivity,
  type AssistantPermission,
  type AssistantStatus,
  type NewAssistant,
  assistantActivity,
  assistantStatus,
  clearAssistantActivity,
  connectAssistant,
  removeAssistant,
  setAssistantEnabled,
  setAssistantPermission,
  toCommandError,
} from "../lib/tauri";
import { SettingsRow, SettingsSection } from "./rows";

/** The write groups, each off until the user allows it. Reading needs only the main switch. */
export const PERMISSIONS: { id: AssistantPermission; title: string; description: string }[] = [
  {
    id: "organize",
    title: "Organize mail",
    description:
      "Archive, move to the inbox, mark read or unread, star, add and remove labels, create labels, and move to Trash.",
  },
  {
    id: "filters",
    title: "Change Gmail filters",
    description: "Create and delete Gmail filters, which act on mail that arrives later.",
  },
  {
    id: "drafts",
    title: "Write drafts",
    description:
      "Save drafts and replies in Drafts for you to review and send. Clients can't send.",
  },
  {
    id: "unsubscribe",
    title: "Unsubscribe",
    description:
      "Unsubscribe from mailing lists that offer one-click unsubscribe. For others, the assistant gives you the link.",
  },
];

/** The command that adds Pheeme to Claude Code. */
export function claudeCommand(url: string, token: string): string {
  return `claude mcp add --transport http pheeme ${url} --header "Authorization: Bearer ${token}"`;
}

function serverText(status: AssistantStatus): string {
  if (status.server.state === "running") return `Listening at ${status.server.url}`;
  if (status.server.state === "failed") return status.server.message ?? "Couldn't start.";
  return "Off. Turn on Allow MCP connections to start it.";
}

/** A logged JSON value, indented; anything else as it was stored. */
function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** One tool call: the summary line, and on expanding, exactly what was sent and what came back. */
function ActivityCall({ call }: { call: AssistantActivity }) {
  return (
    <details className={cx("settings-assistant__call", call.error && "settings-assistant__failed")}>
      <summary className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">{`${call.tool} · ${call.summary}`}</div>
          <div className="settings-row__description">
            {`${call.clientName}, ${formatListDate(call.at)}${call.error ? `: ${call.error}` : ""}`}
          </div>
        </div>
      </summary>
      <div className="settings-assistant__detail">
        <div className="settings-assistant__label">Arguments</div>
        <pre className="settings-assistant__json" aria-label="Arguments">
          {pretty(call.arguments)}
        </pre>
        <div className="settings-assistant__label">Returned</div>
        <pre className="settings-assistant__json" aria-label="Returned">
          {call.result ? pretty(call.result) : (call.error ?? "")}
        </pre>
      </div>
    </details>
  );
}

function Connected({ added, url, onDone }: { added: NewAssistant; url: string; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const command = claudeCommand(url, added.token);
  return (
    <div className="settings-assistant__connect">
      <p className="settings-assistant__hint">
        Run this in a terminal to add Pheeme to Claude Code. The token is shown only now; if you
        lose it, connect the client again.
      </p>
      <code className="settings-assistant__command" aria-label="Claude Code command">
        {command}
      </code>
      <p className="settings-assistant__hint">
        Other MCP clients: server URL <code>{url}</code>, header{" "}
        <code>Authorization: Bearer {added.token}</code>.
      </p>
      <div className="settings-assistant__actions">
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            void navigator.clipboard.writeText(command).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? "Copied" : "Copy command"}
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function AssistantSettings() {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [activity, setActivity] = useState<AssistantActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("Claude Code");
  const [added, setAdded] = useState<NewAssistant | null>(null);

  const fail = (e: unknown) => setError(toCommandError(e).message);
  const loadActivity = useCallback(
    () =>
      assistantActivity().then(setActivity, (e: unknown) => setError(toCommandError(e).message)),
    [],
  );

  useEffect(() => {
    assistantStatus().then(setStatus, (e: unknown) => setError(toCommandError(e).message));
    void loadActivity();
    let unlisten: (() => void) | undefined;
    let live = true;
    void listen(ASSISTANT_ACTIVITY_EVENT, () => {
      void loadActivity();
      void assistantStatus().then(
        (s) => live && setStatus(s),
        () => {},
      );
    }).then(
      (stop) => {
        if (live) unlisten = stop;
        else stop();
      },
      () => {},
    );
    return () => {
      live = false;
      unlisten?.();
    };
  }, [loadActivity]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await setAssistantEnabled(enabled));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function allow(permission: AssistantPermission, allowed: boolean) {
    setError(null);
    try {
      setStatus(await setAssistantPermission(permission, allowed));
    } catch (e) {
      fail(e);
    }
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      setAdded(await connectAssistant(name));
      setStatus(await assistantStatus());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await removeAssistant(id);
      setStatus(await assistantStatus());
    } catch (e) {
      fail(e);
    }
  }

  async function clear() {
    setError(null);
    try {
      await clearAssistantActivity();
      setActivity([]);
    } catch (e) {
      fail(e);
    }
  }

  return (
    <>
      <p className="settings-empty">
        With MCP on, AI assistants such as Claude Code can search and read your mail and list your
        Gmail filters through Pheeme, while Pheeme is open, and change only what you allow below.
        They work through the same actions as the app, never straight on its database, and they
        can't send mail. Only programs on this computer with a token you created can connect, and
        Activity shows every call they make.
      </p>
      {error && (
        <p className="settings-assistant__error" role="alert">
          {error}
        </p>
      )}
      <SettingsSection title="MCP server">
        <SettingsRow
          title="Allow MCP connections"
          description="Runs Pheeme's MCP server on this computer only."
          control={
            <Switch
              label="Allow MCP connections"
              checked={status?.enabled ?? false}
              disabled={status === null || busy}
              onChange={(next) => void toggle(next)}
            />
          }
        />
        <SettingsRow
          title="Server"
          description={status ? serverText(status) : <Skeleton width="16em" />}
        />
      </SettingsSection>
      <SettingsSection title="What clients may change">
        {PERMISSIONS.map((p) => (
          <SettingsRow
            key={p.id}
            title={p.title}
            description={p.description}
            control={
              <Switch
                label={p.title}
                checked={status?.allowed.includes(p.id) ?? false}
                disabled={status === null}
                onChange={(next) => void allow(p.id, next)}
              />
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection
        title="Activity"
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={!activity?.length}
            onClick={() => void clear()}
          >
            Clear
          </Button>
        }
      >
        <div className="settings-assistant__activity">
          {activity === null ? (
            <SettingsRow
              title={<Skeleton width="10em" />}
              description={<Skeleton width="18em" />}
            />
          ) : activity.length === 0 ? (
            <SettingsRow
              title="No activity yet"
              description="Each tool call a client makes shows here. Open one to see exactly what it sent and got back."
            />
          ) : (
            activity.map((a) => <ActivityCall key={a.id} call={a} />)
          )}
        </div>
      </SettingsSection>
      <SettingsSection title="Connected clients">
        {added && status ? (
          <Connected added={added} url={status.server.url} onDone={() => setAdded(null)} />
        ) : (
          <SettingsRow
            title="Connect a client"
            description="Name it, then copy the command Pheeme gives you."
            control={
              <form
                className="settings-assistant__actions"
                onSubmit={(e) => {
                  e.preventDefault();
                  void connect();
                }}
              >
                <TextInput
                  aria-label="Client name"
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button size="sm" type="submit" disabled={status === null || busy || !name.trim()}>
                  Connect
                </Button>
              </form>
            }
          />
        )}
        {/* Last on the page, so the list growing once it loads moves nothing. */}
        {status?.clients.map((c) => (
          <SettingsRow
            key={c.id}
            title={c.name}
            description={`Connected ${formatListDate(c.createdAt)} · ${
              c.lastUsedAt ? `last used ${formatListDate(c.lastUsedAt)}` : "not used yet"
            }`}
            control={
              <Button size="sm" variant="danger" onClick={() => void remove(c.id)}>
                Remove
              </Button>
            }
          />
        ))}
      </SettingsSection>
    </>
  );
}
