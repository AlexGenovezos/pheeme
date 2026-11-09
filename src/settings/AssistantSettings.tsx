// Settings › AI assistants: lets MCP clients (Claude Code and others) work with mail through Pheeme's local API
// while the app is open. Off by default; each client connects with its own token, shown once; every tool call is
// listed under Activity. See docs/ai-assistants.md.
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { Switch } from "../components/ui/Switch";
import { TextInput } from "../components/ui/TextInput";
import { formatListDate } from "../lib/dates";
import {
  ASSISTANT_ACTIVITY_EVENT,
  type AssistantActivity,
  type AssistantStatus,
  type NewAssistant,
  assistantActivity,
  assistantStatus,
  clearAssistantActivity,
  connectAssistant,
  removeAssistant,
  setAssistantEnabled,
  toCommandError,
} from "../lib/tauri";
import { SettingsRow, SettingsSection } from "./rows";

/** The command that adds Pheeme to Claude Code. */
export function claudeCommand(url: string, token: string): string {
  return `claude mcp add --transport http pheeme ${url} --header "Authorization: Bearer ${token}"`;
}

function serverText(status: AssistantStatus): string {
  if (status.server.state === "running") return `Listening at ${status.server.url}`;
  if (status.server.state === "failed") return status.server.message ?? "Couldn't start.";
  return "Off. Turn on Allow AI assistants to start it.";
}

function Connected({ added, url, onDone }: { added: NewAssistant; url: string; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  const command = claudeCommand(url, added.token);
  return (
    <div className="settings-assistant__connect">
      <p className="settings-assistant__hint">
        Run this in a terminal to add Pheeme to Claude Code. The token is shown only now; if you
        lose it, connect again.
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
        AI assistants such as Claude Code can search and read your mail and list your Gmail filters
        through Pheeme, while Pheeme is open. They work through the same actions as the app, never
        straight on its database, and they can't send mail. Only programs on this computer with a
        token you created can connect.
      </p>
      {error && (
        <p className="settings-assistant__error" role="alert">
          {error}
        </p>
      )}
      <SettingsSection title="AI assistants">
        <SettingsRow
          title="Allow AI assistants"
          description="Runs Pheeme's MCP server on this computer only."
          control={
            <Switch
              label="Allow AI assistants"
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
              description="Each tool call an assistant makes shows here."
            />
          ) : (
            activity.map((a) => (
              <SettingsRow
                key={a.id}
                className={a.error ? "settings-assistant__failed" : undefined}
                title={`${a.tool} · ${a.summary}`}
                description={`${a.clientName}, ${formatListDate(a.at)}${a.error ? `: ${a.error}` : ""}`}
              />
            ))
          )}
        </div>
      </SettingsSection>
      <SettingsSection title="Connected assistants">
        {added && status ? (
          <Connected added={added} url={status.server.url} onDone={() => setAdded(null)} />
        ) : (
          <SettingsRow
            title="Connect an assistant"
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
                  aria-label="Assistant name"
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
