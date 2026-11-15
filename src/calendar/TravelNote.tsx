// The travelling note: when the computer keeps another clock than the Google Calendar's zone, one
// line at the foot of the calendar sidebar says so and offers to show the computer's zone beside
// the calendar's. It never changes the calendar's zone (that's Google's setting, on every device).
import { Plane, X } from "lucide-react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { displayZone, useCalendarStore } from "./calendarStore";
import { isValidZone, systemZone } from "./dates";
import { useNow } from "./useNow";
import { MAX_OTHER_ZONES, travelKey, useZoneSettings } from "./zoneSettings";
import { travelNote, zoneCity } from "./zones";

export function TravelNote() {
  const accounts = useCalendarStore((s) => s.accounts);
  const zones = useZoneSettings((s) => s.zones);
  const dismissed = useZoneSettings((s) => s.dismissed);
  const now = useNow();
  // Only once the calendar's zone is known: before that, the fallback is the computer's own.
  const known = accounts?.some((a) => a.access.status === "on" && isValidZone(a.timeZone));
  if (!known) return null;
  const calendarZone = displayZone(accounts);
  const computerZone = systemZone();
  const key = travelKey(calendarZone, computerZone);
  const note = travelNote(calendarZone, computerZone, now);
  if (!note || dismissed.includes(key)) return null;
  const canAdd = zones.length < MAX_OTHER_ZONES && !zones.some((z) => z.zone === computerZone);
  return (
    <section className="cal-travel" aria-label="Time zone">
      <Plane aria-hidden="true" />
      <p className="cal-travel__text">{note}</p>
      <IconButton
        size="sm"
        className="cal-travel__dismiss"
        label="Dismiss"
        icon={<X />}
        onClick={() => useZoneSettings.getState().dismissTravel(key)}
      />
      {canAdd && (
        <Button
          size="sm"
          className="cal-travel__action"
          onClick={() => useZoneSettings.getState().add(computerZone)}
        >
          Show {zoneCity(computerZone)} times
        </Button>
      )}
    </section>
  );
}
