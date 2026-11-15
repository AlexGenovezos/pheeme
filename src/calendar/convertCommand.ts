// The command palette's converter row: a query like "3pm PT in Athens" becomes one result whose
// title is the answer; choosing it copies the answer.
import { toast } from "../components/ui/Toast";
import type { Command } from "../keyboard/registry";
import { parseConversion } from "./zoneConvert";

export const CONVERT_COMMAND = "calendar.convertTime";

/** The answer to `query` as a palette command, or null when it isn't a time to convert. */
export function conversionCommand(
  query: string,
  calendarZone: string,
  now = Date.now(),
): Command | null {
  const conversion = parseConversion(query, { now, calendarZone });
  if (!conversion) return null;
  const { text } = conversion;
  return {
    id: CONVERT_COMMAND,
    title: text,
    group: "Time zones",
    run: () =>
      void navigator.clipboard.writeText(text).then(
        () => void toast({ title: "Copied", description: text }),
        () => void toast({ title: "Couldn't copy the time", tone: "danger" }),
      ),
  };
}
