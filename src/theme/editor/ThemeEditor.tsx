import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  MousePointer2,
  Paintbrush,
  Search,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Switch } from "../../components/ui/Switch";
import { TextInput } from "../../components/ui/TextInput";
import { toast } from "../../components/ui/Toast";
import { cx } from "../../lib/utils";
import { useSettingsStore } from "../../settings/settingsStore";
import { contrastFailures } from "../../styles/themes/contrast";
import { toCanonicalThemeColor } from "../../styles/themes/color";
import type { ThemeToken } from "../../styles/themes/schema";
import type { ResolvedTheme } from "../theme";
import { ColorPicker, splitColor } from "./ColorPicker";
import {
  closeThemeEditor,
  draftTheme,
  fixContrast,
  saveThemeEditor,
  setAdvanced,
  setColor,
  setDraftName,
  setMinimized,
  setSeed,
  setSlot,
  useThemeEditorStore,
} from "./editorStore";
import { TOKEN_GROUPS, tokenLabel } from "./groups";
import { highlightUsage, pickElement, tokensAt } from "./inspector";
import "./ThemeEditor.css";

const SLOTS = [
  { value: "light" as const, label: "Light mode" },
  { value: "dark" as const, label: "Dark mode" },
];

/** One color: its name (click to outline where it's used), a swatch that opens the picker, and its hex. */
const ColorRow = memo(function ColorRow({
  id,
  label,
  value,
  open,
  highlighted,
  onToggleOpen,
  onToggleHighlight,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  open: boolean;
  highlighted: boolean;
  onToggleOpen(id: string): void;
  onToggleHighlight(id: string): void;
  onChange(id: string, value: string): void;
}) {
  const { hex, alpha } = splitColor(value);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? hex + alpha;
  return (
    <div
      className={cx("theme-editor__row", highlighted && "theme-editor__row--highlighted")}
      data-token={id}
    >
      <div className="theme-editor__row-line">
        <button
          type="button"
          className="theme-editor__row-label"
          aria-pressed={highlighted}
          title={`${highlighted ? "Hide" : "Show"} where ${label} is used`}
          onClick={() => onToggleHighlight(id)}
        >
          {label}
        </button>
        <button
          type="button"
          className="theme-editor__swatch"
          aria-label={`Choose ${label} color`}
          aria-expanded={open}
          style={{ backgroundColor: hex }}
          onClick={() => onToggleOpen(id)}
        />
        <input
          className={cx(
            "theme-editor__hex",
            draft !== null && !toCanonicalThemeColor(draft) && "theme-editor__hex--invalid",
          )}
          aria-label={`${label} hex value`}
          spellCheck={false}
          value={shown}
          onChange={(e) => {
            const next = e.currentTarget.value;
            setDraft(next);
            if (toCanonicalThemeColor(next)) onChange(id, next);
          }}
          onBlur={() => setDraft(null)}
        />
      </div>
      {open && <ColorPicker label={label} value={value} onChange={(v) => onChange(id, v)} />}
    </div>
  );
});

/** Keep the panel on screen as the window shrinks. */
function clampPosition(x: number, y: number, el: HTMLElement | null) {
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  const margin = 8;
  return {
    x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - w - margin)),
    y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - h - margin)),
  };
}

function ThemeEditorPanel() {
  const { draft, editingId, slot, advanced, seeds, dirty, minimized } = useThemeEditorStore();
  const theme = useMemo(() => draftTheme(draft), [draft]);
  const failures = useMemo(() => contrastFailures(theme.tokens), [theme]);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<ThemeToken[] | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const stopPicking = useRef<(() => void) | null>(null);

  // Start at the right edge, clear of the title bar.
  useEffect(() => {
    setPos(clampPosition(window.innerWidth, 48, panel.current));
    const reclamp = () => setPos((p) => (p ? clampPosition(p.x, p.y, panel.current) : p));
    window.addEventListener("resize", reclamp);
    // The panel grows too (Every color), which can push its footer off screen.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(reclamp) : null;
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener("resize", reclamp);
      observer?.disconnect();
    };
  }, []);

  // Outline the highlighted color's uses; redrawn as its value changes.
  const highlightValue = highlighted
    ? highlighted === "background" || highlighted === "accent"
      ? theme.tokens[highlighted === "background" ? "--color-app-bg" : "--color-accent"]
      : theme.tokens[highlighted as ThemeToken]
    : null;
  useEffect(() => {
    if (!highlightValue) return;
    // After the preview has painted the new value.
    let clear = () => {};
    const frame = requestAnimationFrame(() => (clear = highlightUsage(highlightValue)));
    return () => {
      cancelAnimationFrame(frame);
      clear();
    };
  }, [highlightValue]);

  useEffect(() => () => stopPicking.current?.(), []);

  const toggleOpen = (id: string) => setOpenRow((o) => (o === id ? null : id));
  const toggleHighlight = (id: string) => setHighlighted((h) => (h === id ? null : id));
  const onSeed = (id: string, value: string) =>
    setSeed(id === "background" ? "background" : "accent", value);
  const onColor = (id: string, value: string) => setColor(id as ThemeToken, value);

  function inspect() {
    if (inspecting) {
      stopPicking.current?.();
      setInspecting(false);
      return;
    }
    setInspecting(true);
    stopPicking.current = pickElement(
      (el) => {
        setInspecting(false);
        const tokens = tokensAt(el, theme.tokens);
        if (!tokens.length) {
          toast({
            title: "No theme color there",
            description: "That part of the app isn't drawn with a theme color.",
          });
          return;
        }
        setAdvanced(true);
        setFilter("");
        setPicked(tokens);
        setOpenRow(tokens[0]);
      },
      () => setInspecting(false),
    );
  }

  /** Closing with changes asks first, in the footer (and expands the panel to show it). */
  function close(discard = false) {
    if (dirty && !discard) {
      setMinimized(false);
      setConfirmingClose(true);
      return;
    }
    if (closeThemeEditor()) useSettingsStore.getState().openSettings("appearance");
  }

  function save() {
    try {
      const name = draft.name.trim() || "My theme";
      if (saveThemeEditor()) useSettingsStore.getState().openSettings("appearance");
      toast({
        title: `Saved ${name}`,
        description: `Pheeme uses it in ${slot === "light" ? "Light" : "Dark"} mode.`,
      });
    } catch (err) {
      toast({ title: "Couldn't save the theme", description: String(err), tone: "danger" });
    }
  }

  function drag(e: PointerEvent<HTMLElement>) {
    if ((e.target as Element).closest("button") || !pos) return;
    const start = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) =>
      setPos(clampPosition(m.clientX - start.x, m.clientY - start.y, panel.current));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  const query = filter.trim().toLowerCase();
  const groups = TOKEN_GROUPS.map((g) => ({
    ...g,
    tokens: g.tokens.filter(
      (t) =>
        (!picked || picked.includes(t)) &&
        (!query || tokenLabel(t).toLowerCase().includes(query) || t.includes(query)),
    ),
  })).filter((g) => g.tokens.length > 0);

  return (
    <div
      ref={panel}
      className={cx("theme-editor", minimized && "theme-editor--minimized")}
      role="dialog"
      aria-label={editingId ? "Edit theme" : "Create theme"}
      data-theme-editor=""
      data-owns-keys=""
      style={pos ? { left: pos.x, top: pos.y } : { visibility: "hidden" }}
    >
      <header className="theme-editor__header" onPointerDown={drag}>
        <Paintbrush size={14} aria-hidden />
        <h2 className="theme-editor__title">{draft.name.trim() || "Untitled theme"}</h2>
        <button
          type="button"
          className={cx("theme-editor__icon", inspecting && "theme-editor__icon--active")}
          aria-pressed={inspecting}
          aria-label={inspecting ? "Stop picking" : "Pick a color from the app"}
          title={inspecting ? "Stop picking (Esc)" : "Pick a color from the app"}
          onClick={inspect}
        >
          <MousePointer2 size={14} aria-hidden />
        </button>
        <button
          type="button"
          className="theme-editor__icon"
          aria-label={minimized ? "Expand the theme editor" : "Minimize the theme editor"}
          onClick={() => setMinimized(!minimized)}
        >
          {minimized ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
        </button>
        <button
          type="button"
          className="theme-editor__icon"
          aria-label="Close the theme editor"
          onClick={() => close()}
        >
          <X size={14} aria-hidden />
        </button>
      </header>

      {!minimized && (
        <>
          <div className="theme-editor__body">
            <label className="theme-editor__field">
              <span>Name</span>
              <TextInput
                value={draft.name}
                maxLength={48}
                onChange={(e) => setDraftName(e.currentTarget.value)}
              />
            </label>
            <div className="theme-editor__field">
              <span>Use in</span>
              <SegmentedControl<ResolvedTheme>
                label="Use in"
                value={slot}
                options={SLOTS}
                onChange={setSlot}
              />
            </div>

            <div className="theme-editor__section-head">
              <h3>Colors</h3>
              <label className="theme-editor__advanced">
                <span>Every color</span>
                <Switch checked={advanced} label="Edit every color" onChange={setAdvanced} />
              </label>
            </div>

            {!advanced ? (
              <div className="theme-editor__group">
                <p className="theme-editor__hint">
                  Pick a background and an accent; Pheeme works out every other color and keeps text
                  readable.
                </p>
                {(["background", "accent"] as const).map((id) => (
                  <ColorRow
                    key={id}
                    id={id}
                    label={id === "background" ? "Background" : "Accent"}
                    value={seeds[id]}
                    open={openRow === id}
                    highlighted={highlighted === id}
                    onToggleOpen={toggleOpen}
                    onToggleHighlight={toggleHighlight}
                    onChange={onSeed}
                  />
                ))}
              </div>
            ) : (
              <>
                <div className="theme-editor__filter">
                  <TextInput
                    leading={<Search size={14} aria-hidden />}
                    placeholder="Filter colors"
                    aria-label="Filter colors"
                    value={filter}
                    onChange={(e) => setFilter(e.currentTarget.value)}
                  />
                  {picked && (
                    <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                      Show all
                    </Button>
                  )}
                </div>
                {groups.map((group) => (
                  <section key={group.title} className="theme-editor__group">
                    <h4>{group.title}</h4>
                    {group.tokens.map((token) => (
                      <ColorRow
                        key={token}
                        id={token}
                        label={tokenLabel(token)}
                        value={theme.tokens[token]}
                        open={openRow === token}
                        highlighted={highlighted === token}
                        onToggleOpen={toggleOpen}
                        onToggleHighlight={toggleHighlight}
                        onChange={onColor}
                      />
                    ))}
                  </section>
                ))}
                {groups.length === 0 && (
                  <p className="theme-editor__hint">No color matches “{filter}”.</p>
                )}
              </>
            )}
          </div>

          <footer className="theme-editor__footer">
            {confirmingClose ? (
              <>
                <span className="theme-editor__confirm">Discard your changes?</span>
                <div className="theme-editor__actions">
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingClose(false)}>
                    Keep editing
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => close(true)}>
                    Discard
                  </Button>
                </div>
              </>
            ) : (
              <>
                {failures.length > 0 ? (
                  <button
                    type="button"
                    className="theme-editor__warning"
                    title={failures.join("\n")}
                    onClick={fixContrast}
                  >
                    <AlertTriangle size={14} aria-hidden />
                    {failures.length === 1
                      ? "1 color is hard to read"
                      : `${failures.length} colors are hard to read`}
                    <span className="theme-editor__warning-action">Fix</span>
                  </button>
                ) : (
                  <span />
                )}
                <div className="theme-editor__actions">
                  <Button size="sm" variant="ghost" onClick={() => close()}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" onClick={save}>
                    {editingId ? "Save" : "Save theme"}
                  </Button>
                </div>
              </>
            )}
          </footer>
        </>
      )}
    </div>
  );
}

/** Mounted once in App: the editor panel while a theme is being edited. */
export function ThemeEditorHost() {
  const open = useThemeEditorStore((s) => s.open);
  return open ? <ThemeEditorPanel /> : null;
}
