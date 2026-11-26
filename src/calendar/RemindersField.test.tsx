import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { type EventForm, newForm } from "./eventForm";
import { RemindersField } from "./RemindersField";

function Harness() {
  const [form, setForm] = useState<EventForm>({
    ...newForm({
      accountId: "a",
      calendarId: "c",
      zone: "UTC",
      allDay: true,
      startDate: "2026-11-26",
    }),
    remindersDefault: false,
    reminders: [
      { method: "popup", amount: 10, unit: "minutes" },
      { method: "email", amount: 2, unit: "hours" },
    ],
  });
  return <RemindersField form={form} onChange={setForm} />;
}

test("removing a notification keeps the other rows' inputs", () => {
  render(<Harness />);
  const [, second] = screen.getAllByLabelText("How long before");
  fireEvent.click(screen.getAllByLabelText("Remove notification")[0]);
  const [only] = screen.getAllByLabelText("How long before");
  expect(only).toBe(second);
  expect((only as HTMLInputElement).value).toBe("2");
});

test("added notifications get their own rows", () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("Add notification"));
  expect(screen.getAllByLabelText("How long before")).toHaveLength(3);
});
