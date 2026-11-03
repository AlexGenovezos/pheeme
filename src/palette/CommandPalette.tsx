import { Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Kbd } from "../components/ui/Kbd";
import {
  registry as defaultRegistry,
  type Command,
  type CommandRegistry,
} from "../keyboard/registry";
import { useCommandList } from "../keyboard/useCommands";
import { filterCommands } from "./match";
import { usePaletteStore } from "./paletteStore";
import "./CommandPalette.css";

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const hit = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        hit.has(i) ? (
          <mark key={i} className="palette__match">
            {ch}
          </mark>
        ) : (
          <Fragment key={i}>{ch}</Fragment>
        ),
      )}
    </>
  );
}

function PaletteDialog({ reg, onClose }: { reg: CommandRegistry; onClose(): void }) {
  const commands = useCommandList(reg);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  const restored = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const grouped = !query.trim();

  const restoreFocus = () => {
    if (restored.current) return;
    restored.current = true;
    returnFocus?.focus?.();
  };

  useEffect(() => {
    restored.current = false;
    inputRef.current?.focus();
    return () => {
      // Closed from outside (Cmd+K again): still hand focus back.
      if (!restored.current) {
        restored.current = true;
        returnFocus?.focus?.();
      }
    };
  }, [returnFocus]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const close = () => {
    restoreFocus();
    onClose();
  };

  const execute = (command: Command | undefined) => {
    if (!command) return;
    // Focus goes back first so commands that move focus (e.g. "/" search) keep it.
    close();
    command.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const count = results.length;
    if (e.key === "ArrowDown" && count) setActive((a) => (a + 1) % count);
    else if (e.key === "ArrowUp" && count) setActive((a) => (a - 1 + count) % count);
    else if (e.key === "Enter") execute(results[active]?.command);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") {
      /* keep focus in the palette */
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const activeId = results[active] ? `palette-option-${active}` : undefined;

  return (
    <div className="palette__scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette__search">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            className="palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            placeholder="Type a command"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div
          ref={listRef}
          id="palette-listbox"
          role="listbox"
          aria-label="Commands"
          className="palette__list"
        >
          {results.length === 0 && (
            <div className="palette__empty">No commands match “{query.trim()}”</div>
          )}
          {results.map(({ command, indices }, i) => {
            const showGroup =
              grouped && command.group && command.group !== results[i - 1]?.command.group;
            return (
              <Fragment key={command.id}>
                {showGroup && (
                  <div className="palette__group" role="presentation">
                    {command.group}
                  </div>
                )}
                <div
                  id={`palette-option-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className="palette__option"
                  onPointerMove={() => i !== active && setActive(i)}
                  onClick={() => execute(command)}
                >
                  <span className="palette__title">
                    <Highlighted text={command.title} indices={indices} />
                  </span>
                  {!grouped && command.group && (
                    <span className="palette__hint">{command.group}</span>
                  )}
                  {command.shortcut && <Kbd shortcut={command.shortcut} />}
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Cmd/Ctrl+K palette over every registered command. Mount once. */
export function CommandPalette({ registry = defaultRegistry }: { registry?: CommandRegistry }) {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  if (!open) return null;
  return <PaletteDialog reg={registry} onClose={() => setOpen(false)} />;
}
