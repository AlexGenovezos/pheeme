import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus, Puzzle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Switch } from "../components/ui/Switch";
import { toCommandError } from "../lib/tauri";
import { isPreview } from "../preview/runtime";
import { SettingsRow, SettingsSection } from "../settings/rows";
import { matchesQuery, type SettingsPageDef } from "../settings/schema";
import { useSettingsStore } from "../settings/settingsStore";
import {
  connectMod,
  connectionStatus,
  discardMod,
  disconnectMod,
  installMod,
  type ModConnection,
  type ModInfo,
  type ModManifest,
  type PreparedMod,
  prepareMod,
  removeMod,
  setModEnabled,
} from "./api";
import { ModControls } from "./ModControls";
import { useModStore } from "./store";
import "./mods.css";

export function Permissions({ manifest }: { manifest: ModManifest }) {
  const { network, connections } = manifest.permissions;
  return (
    <div className="mod-stack">
      <p>
        {network.length || connections.length
          ? "This mod requests:"
          : "This mod needs no network or account access."}
      </p>
      {(network.length > 0 || connections.length > 0) && (
        <ul>
          {network.map((host) => (
            <li key={host}>Contact {host}</li>
          ))}
          {connections.map((connection) => (
            <li key={connection.id}>
              Connect to {connection.name}
              <ul>
                <li>Sign in at {connection.authorizationUrl}</li>
                <li>Exchange tokens at {connection.tokenUrl}</li>
                <li>Use your connection at {connection.apiOrigins.join(", ")}</li>
                <li>Permissions: {connection.scopes.join(", ") || "Basic account access"}</li>
              </ul>
            </li>
          ))}
        </ul>
      )}
      <p className="mod-muted">
        Mods have their own settings and storage. This API gives them no access to your email.
      </p>
    </div>
  );
}

export function ModsSettings({ query = "" }: { query?: string }) {
  const { mods, safeMode, error, loaded } = useModStore();
  const [prepared, setPrepared] = useState<PreparedMod | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Consent belongs to this screen. Closing it discards the unapproved package.
  useEffect(
    () => () => {
      if (prepared) void discardMod(prepared.ticket).catch(() => {});
    },
    [prepared],
  );
  async function chooseFolder() {
    setBusy(true);
    setFailure(null);
    try {
      const path = isPreview()
        ? "examples/mods/counter"
        : await open({ directory: true, multiple: false, title: "Choose a built mod folder" });
      if (typeof path === "string") setPrepared(await prepareMod(path));
    } catch (raw) {
      setFailure(toCommandError(raw).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!prepared) return;
    setBusy(true);
    setFailure(null);
    try {
      await installMod(prepared.ticket);
      setPrepared(null);
    } catch (raw) {
      setFailure(toCommandError(raw).message);
      setPrepared(null);
    } finally {
      await useModStore.getState().load();
      setBusy(false);
    }
  }
  const visible = mods.filter((m) =>
    matchesQuery(`${m.manifest.name} ${m.manifest.description} mods extensions plugins`, query),
  );
  return (
    <>
      <SettingsSection
        title="Your mods"
        action={
          <Button
            size="sm"
            icon={<FolderPlus />}
            disabled={busy}
            onClick={() => void chooseFolder()}
          >
            Install from folder
          </Button>
        }
      >
        {safeMode && (
          <p className="mod-stack" role="status">
            Mods are disabled for this launch. Restart Pheeme without the disable-mods option to run
            them.
          </p>
        )}
        {!loaded && (
          <p className="mod-stack" role="status">
            Loading mods…
          </p>
        )}
        {error && (
          <p className="mod-stack mod-error" role="alert">
            {error}
          </p>
        )}
        {failure && (
          <p className="mod-stack mod-error" role="alert">
            {failure}
          </p>
        )}
        {loaded && !mods.length && (
          <div className="mod-stack">
            <p>Add personal features without maintaining a fork.</p>
            <p className="mod-muted">
              Choose a mod folder to see its details and requested access before installing it.
            </p>
          </div>
        )}
        {isPreview() && (
          <p className="mod-stack mod-muted">
            Browser preview: Install from folder demonstrates the bundled Counter example.
          </p>
        )}
        {visible.map((mod) => (
          <InstalledMod key={mod.manifest.id} mod={mod} safeMode={safeMode} />
        ))}
      </SettingsSection>
      {prepared && (
        <SettingsSection
          title={`${prepared.replacing ? "Update" : "Install"} ${prepared.manifest.name}?`}
        >
          <div className="mod-stack">
            <p>{prepared.manifest.description}</p>
            <p className="mod-muted">
              Version {prepared.manifest.version}.{" "}
              {prepared.replacing
                ? "Replaces the installed package and keeps its preferences."
                : "Runs when Pheeme is open."}
            </p>
          </div>
          <Permissions manifest={prepared.manifest} />
          <div className="mod-stack mod-actions">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setPrepared(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void confirm()}>
              {prepared.replacing ? "Approve update" : "Install and enable"}
            </Button>
          </div>
        </SettingsSection>
      )}
    </>
  );
}

function InstalledMod({ mod, safeMode }: { mod: ModInfo; safeMode: boolean }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [keep, setKeep] = useState(true);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (raw) {
      setFailure(toCommandError(raw).message);
    } finally {
      await useModStore.getState().load();
      setBusy(false);
    }
  }
  return (
    <div>
      <SettingsRow
        title={mod.manifest.name}
        description={`${mod.manifest.description} · v${mod.manifest.version}`}
        control={
          <Switch
            label={`Enable ${mod.manifest.name}`}
            checked={mod.enabled}
            disabled={busy || (safeMode && !mod.enabled)}
            onChange={(enabled) => void perform(() => setModEnabled(mod.manifest.id, enabled))}
          />
        }
      />
      <div className="mod-stack">
        <p className={mod.error ? "mod-error" : "mod-muted"} role={mod.error ? "alert" : undefined}>
          {mod.error ??
            (mod.running ? "Running" : safeMode ? "Disabled for this launch" : "Disabled")}
        </p>
        {failure && (
          <p className="mod-error" role="alert">
            {failure}
          </p>
        )}
        <div className="mod-actions">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => useSettingsStore.getState().openSettings(`mod:${mod.manifest.id}`)}
          >
            Settings
          </Button>
          <Button
            size="sm"
            disabled={busy || safeMode || !mod.running}
            onClick={() => void perform(() => setModEnabled(mod.manifest.id, true))}
          >
            Reload
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>
            Remove
          </Button>
        </div>
        {removing && (
          <>
            <p>
              Remove {mod.manifest.name}? Its saved connections will be deleted. You may also need
              to revoke access in the provider’s account settings.
            </p>
            <label className="mod-field">
              <input
                type="checkbox"
                checked={keep}
                onChange={(event) => setKeep(event.target.checked)}
              />
              Keep preferences for a later reinstall
            </label>
            <div className="mod-actions">
              <Button size="sm" disabled={busy} onClick={() => setRemoving(false)}>
                Keep mod
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => void perform(() => removeMod(mod.manifest.id, keep))}
              >
                Confirm removal
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ModSettings({ id }: { id: string }) {
  const mod = useModStore((s) => s.mods.find((m) => m.manifest.id === id));
  if (!mod) return <p className="mod-stack">This mod is no longer installed.</p>;
  return (
    <>
      <SettingsSection title="Preferences">
        <div className="mod-stack">
          {mod.running ? (
            <ModControls id={id} blocks={mod.views.settings} />
          ) : (
            <p>Enable this mod to use its settings.</p>
          )}
        </div>
      </SettingsSection>
      {mod.manifest.permissions.connections.length > 0 && (
        <SettingsSection title="Connections">
          {mod.manifest.permissions.connections.map((connection) => (
            <ConnectionSettings
              key={connection.id}
              id={id}
              connection={connection}
              running={mod.running}
            />
          ))}
        </SettingsSection>
      )}
      <SettingsSection title="Access">
        <Permissions manifest={mod.manifest} />
      </SettingsSection>
    </>
  );
}

function ConnectionSettings({
  id,
  connection,
  running,
}: {
  id: string;
  connection: ModConnection;
  running: boolean;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void connectionStatus(id, connection.id).then(
      (value) => {
        if (live) setConnected(value);
      },
      (raw) => {
        if (live) setError(toCommandError(raw).message);
      },
    );
    return () => {
      live = false;
    };
  }, [id, connection.id, running]);
  async function perform(disconnect: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (disconnect) await disconnectMod(id, connection.id);
      else await connectMod(id, connection.id, clientId.trim());
      setConnected(!disconnect);
    } catch (raw) {
      setError(toCommandError(raw).message);
    } finally {
      setBusy(false);
      await useModStore.getState().load();
    }
  }
  return (
    <div className="mod-stack">
      <strong>{connection.name}</strong>
      <p className="mod-muted">
        {connected === null ? "Checking connection…" : connected ? "Connected" : "Not connected"}
      </p>
      {!connected && (
        <>
          <label className="mod-input-label">
            Public client ID
            <input
              className="mod-input"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              maxLength={200}
              disabled={busy}
            />
          </label>
          <p className="mod-muted">
            Register a public desktop client with this provider. Set its redirect URI to
            http://127.0.0.1:43821/callback.
          </p>
        </>
      )}
      {busy && (
        <p role="status">
          {connected
            ? "Disconnecting…"
            : "Finish signing in in your browser. Disable the mod to cancel."}
        </p>
      )}
      {error && (
        <p className="mod-error" role="alert">
          {error}
        </p>
      )}
      <div className="mod-actions">
        <Button
          size="sm"
          disabled={busy || connected === null || (!connected && (!running || !clientId.trim()))}
          onClick={() => void perform(connected === true)}
        >
          {connected ? "Disconnect" : "Connect"}
        </Button>
      </div>
      <p className="mod-muted">
        Disconnect removes the saved login from Pheeme. You can revoke the provider’s access grant
        in its account settings.
      </p>
    </div>
  );
}

export function modSettingsPages(mods: ModInfo[]): SettingsPageDef[] {
  return mods.map((mod) => ({
    id: `mod:${mod.manifest.id}`,
    modId: mod.manifest.id,
    title: mod.manifest.name,
    icon: Puzzle,
    group: "Mods",
    keywords: [mod.manifest.description],
    matches: (query) =>
      [...mod.views.settings, ...mod.views.panel].some((block) =>
        matchesQuery(block.type === "text" ? block.text : block.label, query),
      ),
  }));
}
