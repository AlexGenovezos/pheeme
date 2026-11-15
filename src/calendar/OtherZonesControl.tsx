// Settings › Calendar › Other time zones: up to two zones, each with an optional short label, and a
// search for adding one (by city, region, abbreviation or offset).
import { Search, X } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Listbox, PickerPopover, searchListKeys } from "../components/ui/Picker";
import { TextInput } from "../components/ui/TextInput";
import { useNow } from "./useNow";
import { searchZones } from "./zoneConvert";
import { MAX_LABEL_LENGTH, MAX_OTHER_ZONES, useZoneSettings } from "./zoneSettings";
import { formatOffset, offsetMinutes, zoneCity, zoneShortName } from "./zones";
import "./zoneSettings.css";

function AddZone({ taken, now }: { taken: string[]; now: number }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const field = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const query = text.trim();
  const results = useMemo(
    () => searchZones(query, now).filter((z) => !taken.includes(z.zone)),
    [query, taken, now],
  );
  const open = query.length > 0;
  const options = results.map((z, i) => ({ id: `${listId}-${i}`, label: z.label }));

  const choose = (i: number) => {
    const zone = results[i]?.zone;
    if (!zone) return;
    useZoneSettings.getState().add(zone);
    setText("");
  };

  // Escape clears the search, and doesn't close Settings.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) =>
    searchListKeys(e, {
      open,
      count: options.length,
      setActive,
      pick: () => choose(active),
      escape: open ? () => setText("") : undefined,
    });

  return (
    <span ref={field} className="zone-settings__add">
      <TextInput
        leading={<Search aria-hidden="true" />}
        role="combobox"
        aria-label="Add a time zone"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[active] ? options[active].id : undefined}
        placeholder="Add a time zone"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onBlur={() => setText("")}
        onKeyDown={onKeyDown}
      />
      {open && (
        <PickerPopover
          anchor={field}
          onClose={() => setText("")}
          className="ui-picker--list"
          matchWidth
        >
          {options.length > 0 ? (
            <Listbox
              id={listId}
              label="Time zones"
              options={options}
              active={active}
              onActive={setActive}
              onPick={choose}
            />
          ) : (
            <p className="zone-settings__none">No time zone by that name</p>
          )}
        </PickerPopover>
      )}
    </span>
  );
}

export function OtherZonesControl() {
  const zones = useZoneSettings((s) => s.zones);
  const { remove, setLabel } = useZoneSettings.getState();
  const now = useNow();
  const taken = useMemo(() => zones.map((z) => z.zone), [zones]);
  return (
    <div className="zone-settings">
      {zones.map((z) => {
        const city = zoneCity(z.zone);
        return (
          <div key={z.zone} className="zone-settings__zone">
            <span className="zone-settings__name" title={z.zone}>
              {city}{" "}
              <span className="zone-settings__offset">
                {formatOffset(offsetMinutes(now, z.zone))}
              </span>
            </span>
            <TextInput
              className="zone-settings__label"
              aria-label={`Short label for ${city}`}
              placeholder={zoneShortName(z.zone, now)}
              maxLength={MAX_LABEL_LENGTH}
              value={z.label}
              onChange={(e) => setLabel(z.zone, e.target.value)}
            />
            <IconButton
              size="sm"
              label={`Remove ${city}`}
              icon={<X />}
              onClick={() => remove(z.zone)}
            />
          </div>
        );
      })}
      {zones.length < MAX_OTHER_ZONES && <AddZone taken={taken} now={now} />}
    </div>
  );
}
