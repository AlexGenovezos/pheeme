import { cx } from "../lib/utils";
import { EVENT_COLORS } from "./colors";

/** Google's names for the event colours. */
const COLOR_NAMES: Record<string, string> = {
  "1": "Lavender",
  "2": "Sage",
  "3": "Grape",
  "4": "Flamingo",
  "5": "Banana",
  "6": "Tangerine",
  "7": "Peacock",
  "8": "Graphite",
  "9": "Blueberry",
  "10": "Basil",
  "11": "Tomato",
};

export function ColorField({
  value,
  calendarColor: own,
  onChange,
}: {
  value: string;
  calendarColor: string;
  onChange(colorId: string): void;
}) {
  const options = [
    { id: "", name: "Calendar colour", color: own },
    ...Object.entries(EVENT_COLORS).map(([id, color]) => ({ id, name: COLOR_NAMES[id], color })),
  ];
  return (
    <div className="cal-colors" role="radiogroup" aria-label="Event colour">
      {options.map((o) => (
        <button
          key={o.id || "calendar"}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          aria-label={o.name}
          title={o.name}
          className={cx("cal-colors__swatch", o.id === "" && "cal-colors__swatch--calendar")}
          style={{ background: o.color }}
          onClick={() => onChange(o.id)}
        />
      ))}
    </div>
  );
}
