import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TimeFields } from "./EventFields";
import type { EventForm } from "./eventForm";

const timed = (patch: Partial<EventForm>) =>
  ({
    allDay: false,
    startDate: "2026-11-13",
    startMinutes: 22 * 60,
    endDate: "2026-11-13",
    endMinutes: 23 * 60,
    startZone: "America/Chicago",
    endZone: "America/Chicago",
    ...patch,
  }) as EventForm;

test("an end picked from the list as a length lands on the right day", () => {
  const onChange = vi.fn();
  // 10 PM to 1 AM the next day.
  render(
    <TimeFields
      compact
      form={timed({ endDate: "2026-11-14", endMinutes: 60 })}
      onChange={onChange}
    />,
  );
  const end = screen.getByRole("combobox", { name: "End time" });
  fireEvent.mouseDown(end);
  // Past midnight: the next day.
  fireEvent.click(screen.getByRole("option", { name: "12:30 AM (2.5 hrs)" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ endDate: "2026-11-14", endMinutes: 30 }),
  );
  // Before midnight: back to the start's day.
  fireEvent.mouseDown(end);
  fireEvent.click(screen.getByRole("option", { name: "11:00 PM (1 hr)" }));
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ endDate: "2026-11-13", endMinutes: 23 * 60 }),
  );
});
