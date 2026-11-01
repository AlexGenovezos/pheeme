import { Kbd } from "../components/ui/Kbd";
import { registry as defaultRegistry, type CommandRegistry } from "../keyboard/registry";
import { usePendingChord } from "../keyboard/useCommands";

/** After the first key of a chord ("g"), list what the next key does. */
export function ChordHint({ registry = defaultRegistry }: { registry?: CommandRegistry }) {
  const pending = usePendingChord(registry);
  if (!pending) return null;
  const options = registry.completions();
  return (
    <div className="chord-hint" role="status" aria-live="polite">
      <Kbd shortcut={pending} />
      <ul className="chord-hint__list">
        {options.map(({ command, next }) => (
          <li key={command.id} className="chord-hint__item">
            <Kbd shortcut={next} />
            <span>{command.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
