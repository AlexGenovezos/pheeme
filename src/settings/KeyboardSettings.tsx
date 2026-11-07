import { RotateCcw, TriangleAlert, X } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import {
  findConflicts,
  resetAllBindings,
  resetBinding,
  setBinding,
  setBindings,
  stepFromEvent,
} from "../keyboard/bindings";
import { describeShortcut } from "../keyboard/format";
import { type Command, registry } from "../keyboard/registry";
import { useCommandList } from "../keyboard/useCommands";
import { KeyboardMap } from "./KeyboardMap";
import { SettingsRow, SettingsSection } from "./rows";
import { matchesQuery } from "./schema";

/** How long the recorder waits for the second key of a sequence like `g i`. */
export const SEQUENCE_WAIT_MS = 900;

export function commandMatches(command: Command, query: string): boolean {
  const keys = command.shortcut ? `${command.shortcut} ${describeShortcut(command.shortcut)}` : "";
  return matchesQuery(
    [command.title, command.group, ...(command.keywords ?? []), keys].join(" "),
    query,
  );
}

const useOverrides = () => useSyncExternalStore(registry.subscribe, registry.overrides);

export function ResetAllShortcuts() {
  const any = Object.keys(useOverrides()).length > 0;
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<RotateCcw />}
      disabled={!any}
      onClick={() => resetAllBindings()}
    >
      Reset all shortcuts
    </Button>
  );
}

interface Conflict {
  id: string;
  shortcut: string;
  others: Command[];
}

/** Every command, grouped, with its shortcut. Click a shortcut and press keys to change it. */
export function KeyboardSettings({ query }: { query: string }) {
  const commands = useCommandList();
  const overrides = useOverrides();
  const [filter, setFilter] = useState(query);
  /** Commands picked on the keyboard map; while set, the list shows only these. */
  const [picked, setPicked] = useState<{ ids: string[]; label: string } | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // A new search in the dialog's search box replaces this page's filter.
  const [seenQuery, setSeenQuery] = useState(query);
  if (query !== seenQuery) {
    setSeenQuery(query);
    setFilter(query);
    setPicked(null);
  }

  const groups = useMemo(() => {
    const byGroup = new Map<string, Command[]>();
    for (const c of commands) {
      if (picked ? !picked.ids.includes(c.id) : filter.trim() && !commandMatches(c, filter))
        continue;
      const group = c.group ?? "Other";
      byGroup.set(group, [...(byGroup.get(group) ?? []), c]);
    }
    return [...byGroup];
  }, [commands, filter, picked]);

  const commit = (id: string, shortcut: string) => {
    setRecording(null);
    const others = findConflicts(shortcut, commands, id);
    if (others.length) setConflict({ id, shortcut, others });
    else {
      setConflict(null);
      setBinding(id, shortcut);
    }
  };

  const replace = ({ id, shortcut, others }: Conflict) => {
    setBindings({ [id]: shortcut, ...Object.fromEntries(others.map((o) => [o.id, null])) });
    setConflict(null);
  };

  return (
    <div className="settings-keyboard">
      <KeyboardMap
        commands={commands}
        onPick={(list) =>
          setPicked({
            ids: list.map((c) => c.id),
            label: describeShortcut(list[0].shortcut!),
          })
        }
      />
      <div className="kbmap-filter">
        <input
          className="settings-filter"
          type="search"
          aria-label="Filter shortcuts"
          placeholder="Filter by command or key"
          spellCheck={false}
          value={filter}
          onChange={(e) => {
            setPicked(null);
            setFilter(e.target.value);
          }}
        />
        {picked && (
          <p className="kbmap-picked">
            <span>Showing {picked.label}</span>
            <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
              Show all
            </Button>
          </p>
        )}
      </div>
      {groups.length === 0 && <p className="settings-empty">No commands match “{filter.trim()}”</p>}
      {groups.map(([group, list]) => (
        <SettingsSection key={group} title={group}>
          {list.map((command) => {
            const overridden = Object.prototype.hasOwnProperty.call(overrides, command.id);
            const rowConflict = conflict?.id === command.id ? conflict : null;
            return (
              <SettingsRow
                key={command.id}
                className="settings-row--shortcut"
                title={command.title}
                description={
                  rowConflict && (
                    <span className="settings-conflict" role="alert">
                      <TriangleAlert aria-hidden="true" />
                      <span>
                        {describeShortcut(rowConflict.shortcut)} is used by{" "}
                        {rowConflict.others.map((o) => `“${o.title}”`).join(", ")}.
                      </span>
                      <Button size="sm" onClick={() => replace(rowConflict)}>
                        Replace
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
                        Cancel
                      </Button>
                    </span>
                  )
                }
                control={
                  <>
                    {overridden && (
                      <IconButton
                        size="sm"
                        className="settings-shortcut-action"
                        label={`Reset ${command.title} to ${
                          registry.defaultShortcut(command.id)
                            ? describeShortcut(registry.defaultShortcut(command.id)!)
                            : "no shortcut"
                        }`}
                        icon={<RotateCcw />}
                        onClick={() => {
                          // Back to the default can clash with keys another command took since.
                          const original = registry.defaultShortcut(command.id);
                          if (original) commit(command.id, original);
                          else resetBinding(command.id);
                        }}
                      />
                    )}
                    {command.shortcut ? (
                      <IconButton
                        size="sm"
                        className="settings-shortcut-action settings-shortcut-action--hover"
                        label={`Remove shortcut for ${command.title}`}
                        icon={<X />}
                        onClick={() => setBinding(command.id, null)}
                      />
                    ) : (
                      <span className="settings-shortcut-slot" aria-hidden="true" />
                    )}
                    <ShortcutRecorder
                      command={command}
                      recording={recording === command.id}
                      onStart={() => {
                        setConflict(null);
                        setRecording(command.id);
                      }}
                      onCancel={() => setRecording((r) => (r === command.id ? null : r))}
                      onCommit={(shortcut) => commit(command.id, shortcut)}
                    />
                  </>
                }
              />
            );
          })}
        </SettingsSection>
      ))}
    </div>
  );
}

const hasModifier = (step: string) => /^(mod|ctrl|alt|meta)\+/.test(step);

/**
 * The shortcut as a button. While recording, the next key press becomes the shortcut; a plain key
 * waits briefly for a second one so sequences like `g i` can be recorded. Esc cancels.
 */
function ShortcutRecorder({
  command,
  recording,
  onStart,
  onCancel,
  onCommit,
}: {
  command: Command;
  recording: boolean;
  onStart(): void;
  onCancel(): void;
  onCommit(shortcut: string): void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Each recording starts from no keys.
  const [wasRecording, setWasRecording] = useState(recording);
  if (recording !== wasRecording) {
    setWasRecording(recording);
    setSteps([]);
  }

  useEffect(() => {
    if (recording) ref.current?.focus();
    return () => clearTimeout(timer.current);
  }, [recording]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    if (e.key === "Tab") return; // leave: blur cancels
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      onCancel();
      return;
    }
    const step = stepFromEvent(e.nativeEvent);
    if (!step) return; // a modifier on its own: wait for the key
    clearTimeout(timer.current);
    const next = [...steps, step];
    if (next.length === 2 || hasModifier(step)) {
      onCommit(next.join(" "));
      return;
    }
    setSteps(next);
    timer.current = setTimeout(() => onCommit(next.join(" ")), SEQUENCE_WAIT_MS);
  };

  const label = recording
    ? `Recording a shortcut for ${command.title}. Press keys, or Escape to cancel.`
    : command.shortcut
      ? `Change shortcut for ${command.title}, currently ${describeShortcut(command.shortcut)}`
      : `Add a shortcut for ${command.title}`;

  return (
    <button
      ref={ref}
      type="button"
      className="settings-recorder"
      data-recording={recording || undefined}
      aria-label={label}
      onClick={() => !recording && onStart()}
      onKeyDown={onKeyDown}
      onBlur={() => recording && onCancel()}
    >
      {recording ? (
        steps.length ? (
          <>
            <Kbd shortcut={steps.join(" ")} />
            <span className="settings-recorder__hint">then…</span>
          </>
        ) : (
          <span className="settings-recorder__hint">Press keys…</span>
        )
      ) : command.shortcut ? (
        <Kbd shortcut={command.shortcut} />
      ) : (
        <span className="settings-recorder__empty">Add shortcut</span>
      )}
    </button>
  );
}
