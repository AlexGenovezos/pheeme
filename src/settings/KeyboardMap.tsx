import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "../components/ui/Kbd";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { describeShortcut } from "../keyboard/format";
import {
  type BoardKey,
  boardRows,
  buildKeyboardMap,
  capLabel,
  layerIdFor,
  layerSize,
  type MapLayer,
  type Modifier,
  PLAIN_LAYER,
} from "../keyboard/keyboardMap";
import type { Command } from "../keyboard/registry";
import { platform as currentPlatform, type Platform } from "../lib/platform";
import "./KeyboardMap.css";

/** Group swatches reuse the avatar palette. */
const GROUP_COLORS = 6;

type Cap =
  | { kind: "free" }
  | { kind: "used"; commands: Command[] }
  /** A modifier or sequence key that switches to another layer. */
  | { kind: "opens"; layer: MapLayer }
  /** A modifier or prefix key held down for the layer on show; clicking lets go of it. */
  | { kind: "held"; back: string };

const heldModifiers = (e: KeyboardEvent): Modifier[] =>
  (
    [
      [e.ctrlKey, "ctrl"],
      [e.altKey, "alt"],
      [e.shiftKey, "shift"],
      [e.metaKey, "meta"],
    ] as const
  )
    .filter(([down]) => down)
    .map(([, m]) => m);

const commandsIn = (layer: MapLayer) => [...layer.bindings.values()].flat();

interface Tip {
  key: BoardKey;
  style: CSSProperties;
  placement: "above" | "below";
  align: "start" | "center" | "end";
}

/**
 * The shortcuts drawn on a keyboard, one layer (modifier or sequence prefix) at a time. Holding a
 * modifier shows its layer; clicking a used key hands its commands to `onPick`.
 */
export function KeyboardMap({
  commands,
  onPick,
  platform = currentPlatform,
}: {
  commands: Command[];
  onPick(commands: Command[]): void;
  platform?: Platform;
}) {
  const layers = useMemo(() => buildKeyboardMap(commands, platform), [commands, platform]);
  const rows = useMemo(() => boardRows(platform), [platform]);
  const byId = useMemo(() => new Map(layers.map((l) => [l.id, l])), [layers]);
  const groups = useMemo(() => [...new Set(commands.map((c) => c.group ?? "Other"))], [commands]);
  const [chosen, setChosen] = useState(PLAIN_LAYER);
  const [peek, setPeek] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const active = byId.get(peek ?? chosen) ?? byId.get(PLAIN_LAYER)!;

  useEffect(() => {
    const track = (e: KeyboardEvent) => {
      const mods = heldModifiers(e);
      const id = layerIdFor(mods);
      setPeek(mods.length && byId.has(id) ? id : null);
    };
    const release = () => setPeek(null);
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", release);
    };
  }, [byId]);

  const show = (id: string) => {
    setChosen(id);
    setPeek(null);
  };

  function capFor(key: BoardKey): Cap {
    const sequence = active.prefix !== null;
    if (key.modifier) {
      if (active.mods.includes(key.modifier)) {
        const rest = layerIdFor(active.mods.filter((m) => m !== key.modifier));
        return { kind: "held", back: sequence ? (active.parent ?? PLAIN_LAYER) : rest };
      }
      const next = byId.get(layerIdFor([...active.mods, key.modifier]));
      return !sequence && next ? { kind: "opens", layer: next } : { kind: "free" };
    }
    if (sequence && key.key === active.prefixKey)
      return { kind: "held", back: active.parent ?? PLAIN_LAYER };
    const opens = active.prefixes.get(key.key);
    if (opens) return { kind: "opens", layer: byId.get(opens)! };
    const bound = active.bindings.get(key.key);
    return bound ? { kind: "used", commands: bound } : { kind: "free" };
  }

  const colorOf = (group?: string) =>
    `var(--color-avatar-${(groups.indexOf(group ?? "Other") % GROUP_COLORS) + 1})`;

  const point = (key: BoardKey, row: number, target: HTMLElement) => {
    const board = boardRef.current!.getBoundingClientRect();
    const cap = target.getBoundingClientRect();
    const center = cap.left + cap.width / 2 - board.left;
    const align =
      center < board.width * 0.2 ? "start" : center > board.width * 0.8 ? "end" : "center";
    const left = { start: cap.left - board.left, center, end: cap.right - board.left }[align];
    const placement = row === 0 ? "below" : "above";
    const top = placement === "below" ? cap.bottom - board.top : cap.top - board.top;
    setTip({ key, style: { left, top }, placement, align });
  };

  const tipBody = (cap: Cap) => {
    const list = (items: Command[]) => (
      <ul className="kbmap__tip-list">
        {items.map((c) => (
          <li key={c.id}>
            <span>{c.title}</span>
            {c.shortcut && <Kbd shortcut={c.shortcut} platform={platform} />}
          </li>
        ))}
      </ul>
    );
    if (cap.kind === "used") return list(cap.commands);
    if (cap.kind === "opens") {
      const count = layerSize(cap.layer);
      const what = cap.layer.prefix
        ? `Starts ${count === 1 ? "a sequence" : `${count} sequences`}`
        : `${count} ${cap.layer.label} shortcut${count === 1 ? "" : "s"}`;
      return (
        <>
          <p className="kbmap__tip-heading">{what} · click to show</p>
          {list(commandsIn(cap.layer))}
        </>
      );
    }
    if (cap.kind === "held")
      return <p className="kbmap__tip-heading">Showing {active.label} · click to go back</p>;
    return null;
  };

  const onBoard = new Set(rows.flat().map((k) => k.key));
  const offBoard = [...active.bindings].flatMap(([key, list]) => (onBoard.has(key) ? [] : list));
  const shownGroups = groups.filter((g) =>
    commandsIn(active).some((c) => (c.group ?? "Other") === g),
  );
  const tipBodyNow = tip && tipBody(capFor(tip.key));

  return (
    <div className="kbmap">
      <SegmentedControl
        label="Shortcut layer"
        className="kbmap__layers"
        value={active.id}
        options={layers.map((l) => ({ value: l.id, label: l.label, count: layerSize(l) }))}
        onChange={show}
      />
      <div
        ref={boardRef}
        className="kbmap__board"
        role="group"
        aria-label={`Keyboard map, ${active.label}`}
      >
        {rows.map((row, r) => (
          <div key={r} className="kbmap__row">
            {row.map((key, i) => {
              const cap = capFor(key);
              const label = capLabel(key, platform);
              const style = {
                "--kbmap-width": key.width,
                ...(cap.kind === "used" && { "--kbmap-color": colorOf(cap.commands[0].group) }),
              } as CSSProperties;
              if (cap.kind === "free")
                return (
                  <span key={i} className="kbmap__key" style={style} aria-hidden="true">
                    {label}
                  </span>
                );
              const name =
                cap.kind === "used"
                  ? `${label}: ${cap.commands.map((c) => c.title).join(", ")}`
                  : cap.kind === "opens"
                    ? `${label}: show ${cap.layer.label} shortcuts`
                    : `${label}: back`;
              return (
                <button
                  key={i}
                  type="button"
                  tabIndex={-1}
                  className="kbmap__key"
                  data-kind={cap.kind}
                  style={style}
                  aria-label={name}
                  onMouseEnter={(e) => point(key, r, e.currentTarget)}
                  onMouseLeave={() => setTip(null)}
                  onFocus={(e) => point(key, r, e.currentTarget)}
                  onBlur={() => setTip(null)}
                  onClick={() => {
                    setTip(null);
                    if (cap.kind === "used") onPick(cap.commands);
                    else show(cap.kind === "opens" ? cap.layer.id : cap.back);
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ))}
        {tip && tipBodyNow && (
          <div
            className="kbmap__tip"
            data-placement={tip.placement}
            data-align={tip.align}
            style={tip.style}
            aria-hidden="true"
          >
            {tipBodyNow}
          </div>
        )}
      </div>
      <div className="kbmap__legend">
        {shownGroups.map((g) => (
          <span
            key={g}
            className="kbmap__swatch"
            style={{ "--kbmap-color": colorOf(g) } as CSSProperties}
          >
            {g}
          </span>
        ))}
        <span className="kbmap__swatch kbmap__swatch--free">Free</span>
        {offBoard.length > 0 && (
          <span className="kbmap__off-board">
            Also:{" "}
            {offBoard
              .map((c) => `${describeShortcut(c.shortcut!, platform)} ${c.title}`)
              .join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}
