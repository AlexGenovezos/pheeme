import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DateField, formatDateValue } from "./DateField";
import { Modal } from "./Modal";
import { Select, type SelectOption } from "./Select";
import { formatDuration, parseTimeText, TimeField } from "./TimeField";

afterEach(() => vi.useRealTimers());

const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(el, { key: k, ...init });

/** A controlled field, with the value it holds and the parent's keydowns counted. */
function harness<T>(
  initial: T,
  field: (value: T, onChange: (v: T) => void) => React.ReactNode,
): { value: () => T; parentKeys: string[] } {
  const parentKeys: string[] = [];
  let current = initial;
  function Host() {
    const [value, setValue] = useState(initial);
    current = value;
    return <div onKeyDown={(e) => parentKeys.push(e.key)}>{field(value, setValue)}</div>;
  }
  render(<Host />);
  return { value: () => current, parentKeys };
}

describe("parseTimeText", () => {
  test.each([
    ["3p", 15 * 60],
    ["3 PM", 15 * 60],
    ["3:30pm", 15 * 60 + 30],
    ["3:30 p.m.", 15 * 60 + 30],
    ["15:30", 15 * 60 + 30],
    ["330", 3 * 60 + 30],
    ["1530", 15 * 60 + 30],
    ["9", 9 * 60],
    ["12a", 0],
    ["12pm", 12 * 60],
    ["noon", 12 * 60],
    ["midnight", 0],
    ["9.15", 9 * 60 + 15],
  ])("%s", (text, minutes) => expect(parseTimeText(text)).toBe(minutes));

  test.each(["", "abc", "25:00", "13pm", "3:75", "0am", "12345"])("rejects %j", (text) =>
    expect(parseTimeText(text)).toBeNull(),
  );
});

test("durations read like Google's", () => {
  expect(formatDuration(30)).toBe("30 mins");
  expect(formatDuration(60)).toBe("1 hr");
  expect(formatDuration(90)).toBe("1.5 hrs");
  expect(formatDuration(75)).toBe("1.25 hrs");
});

describe("Select", () => {
  const options: SelectOption<number>[] = [
    { value: 1, label: "Apple" },
    { value: 2, label: "Banana", disabled: true },
    { value: 3, label: "Blueberry" },
    { value: 4, label: "Cherry" },
  ];
  const fruit = (value: number, onChange: (v: number) => void) => (
    <Select aria-label="Fruit" value={value} options={options} onChange={onChange} />
  );

  test("shows the chosen label, opens on click and picks with a click", () => {
    const h = harness(1, fruit);
    const box = screen.getByRole("combobox", { name: "Fruit" });
    expect(box).toHaveTextContent("Apple");
    expect(box).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(box);
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("option", { name: "Apple" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("option", { name: "Cherry" }));
    expect(h.value()).toBe(4);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).toHaveTextContent("Cherry");
  });

  test("arrows skip disabled options; Home/End; Enter chooses", () => {
    const h = harness(1, fruit);
    const box = screen.getByRole("combobox", { name: "Fruit" });
    key(box, "ArrowDown");
    const active = () => document.getElementById(box.getAttribute("aria-activedescendant")!);
    expect(active()).toHaveTextContent("Apple");
    key(box, "ArrowDown");
    expect(active()).toHaveTextContent("Blueberry");
    key(box, "End");
    expect(active()).toHaveTextContent("Cherry");
    key(box, "Home");
    expect(active()).toHaveTextContent("Apple");
    key(box, "ArrowDown");
    key(box, "Enter");
    expect(h.value()).toBe(3);
    expect(box).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes only the list; the next Escape is the parent's", () => {
    const h = harness(1, fruit);
    const box = screen.getByRole("combobox", { name: "Fruit" });
    fireEvent.click(box);
    key(box, "Escape");
    expect(box).toHaveAttribute("aria-expanded", "false");
    expect(h.parentKeys).toEqual([]);
    key(box, "Escape");
    expect(h.parentKeys).toEqual(["Escape"]);
    expect(h.value()).toBe(1);
  });

  test("type-ahead finds options by their first letters", () => {
    vi.useFakeTimers();
    harness(1, fruit);
    const box = screen.getByRole("combobox", { name: "Fruit" });
    key(box, "c");
    const active = () => document.getElementById(box.getAttribute("aria-activedescendant")!);
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(active()).toHaveTextContent("Cherry");
    act(() => void vi.advanceTimersByTime(1000));
    // "b" skips the disabled Banana.
    key(box, "b");
    expect(active()).toHaveTextContent("Blueberry");
  });

  test("groups options under their headings", () => {
    render(
      <Select
        aria-label="Calendar"
        value="a"
        options={[
          { value: "a", label: "Personal", group: "me@example.com" },
          { value: "b", label: "Work", group: "me@example.org" },
        ]}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Calendar" }));
    expect(screen.getByRole("group", { name: "me@example.org" })).toHaveTextContent("Work");
  });

  test("an outside press closes the list; a press inside keeps focus on the field", () => {
    harness(1, fruit);
    const box = screen.getByRole("combobox", { name: "Fruit" });
    box.focus();
    fireEvent.click(box);
    const option = screen.getByRole("option", { name: "Cherry" });
    expect(option.closest("[data-picker]")).not.toBeNull();
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.pointerDown(document.body);
    expect(box).toHaveAttribute("aria-expanded", "false");
  });
});

describe("DateField", () => {
  test("shows the date as Google does and picks a day with a click", () => {
    const h = harness("2026-11-13", (value, onChange) => (
      <DateField aria-label="Date" value={value} onChange={onChange} />
    ));
    const field = screen.getByRole("combobox", { name: "Date" });
    expect(field).toHaveTextContent(formatDateValue("2026-11-13"));
    expect(formatDateValue("2026-11-13")).toBe("Fri, Nov 13, 2026");
    fireEvent.click(field);
    expect(screen.getByRole("grid", { name: "November 2026" })).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell")).toHaveLength(42);
    fireEvent.click(screen.getByRole("gridcell", { name: "Wednesday, November 25, 2026" }));
    expect(h.value()).toBe("2026-11-25");
    expect(screen.queryByRole("grid")).toBeNull();
  });

  test("arrows move by day and week, PageDown by month, Enter picks", () => {
    const h = harness("2026-01-31", (value, onChange) => (
      <DateField aria-label="Date" value={value} onChange={onChange} />
    ));
    const field = screen.getByRole("combobox", { name: "Date" });
    key(field, "Enter");
    const active = () => document.getElementById(field.getAttribute("aria-activedescendant")!);
    expect(active()).toHaveAccessibleName("Saturday, January 31, 2026");
    key(field, "PageDown");
    // Kept within February.
    expect(active()).toHaveAccessibleName("Saturday, February 28, 2026");
    expect(screen.getByRole("grid", { name: "February 2026" })).toBeInTheDocument();
    key(field, "ArrowRight");
    key(field, "ArrowDown");
    key(field, "ArrowLeft");
    expect(active()).toHaveAccessibleName("Saturday, March 7, 2026");
    key(field, "Enter");
    expect(h.value()).toBe("2026-03-07");
  });

  test("days before `min` can't be picked; Escape closes only the grid", () => {
    const h = harness("2026-11-13", (value, onChange) => (
      <DateField aria-label="End date" value={value} min="2026-11-13" onChange={onChange} />
    ));
    const field = screen.getByRole("combobox", { name: "End date" });
    fireEvent.click(field);
    const before = screen.getByRole("gridcell", { name: "Thursday, November 12, 2026" });
    expect(before).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(before);
    expect(h.value()).toBe("2026-11-13");
    key(field, "ArrowLeft");
    expect(document.getElementById(field.getAttribute("aria-activedescendant")!)).toBe(
      screen.getByRole("gridcell", { name: "Friday, November 13, 2026" }),
    );
    key(field, "Escape");
    expect(screen.queryByRole("grid")).toBeNull();
    expect(h.parentKeys).toEqual([]);
  });

  test("no date shows the placeholder and opens on today; weeks can start on Monday", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 12));
    render(
      <DateField
        aria-label="Due date"
        placeholder="Add a due date"
        value=""
        weekStart={1}
        onChange={() => {}}
      />,
    );
    const field = screen.getByRole("combobox", { name: "Due date" });
    expect(field).toHaveTextContent("Add a due date");
    fireEvent.click(field);
    expect(screen.getAllByRole("columnheader")[0]).toHaveAccessibleName("Monday");
    expect(screen.getByRole("gridcell", { name: "Tuesday, November 10, 2026" })).toHaveAttribute(
      "aria-current",
      "date",
    );
  });
});

describe("TimeField", () => {
  test("takes a typed time on Enter, and leaves an unchanged Enter to the form", () => {
    const h = harness(9 * 60, (value, onChange) => (
      <TimeField aria-label="Start time" value={value} onChange={onChange} />
    ));
    const input = screen.getByRole("combobox", { name: "Start time" });
    expect(input).toHaveValue("9:00 AM");
    fireEvent.change(input, { target: { value: "3p" } });
    key(input, "Enter");
    expect(h.value()).toBe(15 * 60);
    expect(input).toHaveValue("3:00 PM");
    expect(h.parentKeys).toEqual([]);
    key(input, "Enter");
    expect(h.parentKeys).toEqual(["Enter"]);
  });

  test("takes a typed time on blur; nonsense goes back to the time", () => {
    const h = harness(9 * 60, (value, onChange) => (
      <TimeField aria-label="Start time" value={value} onChange={onChange} />
    ));
    const input = screen.getByRole("combobox", { name: "Start time" });
    fireEvent.change(input, { target: { value: "330" } });
    fireEvent.blur(input);
    expect(h.value()).toBe(3 * 60 + 30);
    fireEvent.change(input, { target: { value: "soon" } });
    fireEvent.blur(input);
    expect(h.value()).toBe(3 * 60 + 30);
    expect(input).toHaveValue("3:30 AM");
  });

  test("lists times every 15 minutes; arrows and Enter pick one", () => {
    const h = harness(9 * 60, (value, onChange) => (
      <TimeField aria-label="Start time" value={value} onChange={onChange} />
    ));
    const input = screen.getByRole("combobox", { name: "Start time" });
    key(input, "ArrowDown");
    expect(screen.getAllByRole("option")).toHaveLength(96);
    expect(screen.getByRole("option", { name: "9:00 AM" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    key(input, "Enter");
    expect(h.value()).toBe(9 * 60 + 30);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("an end time lists lengths from the start", () => {
    const h = harness(11 * 60, (value, onChange) => (
      <TimeField aria-label="End time" value={value} durationFrom={11 * 60} onChange={onChange} />
    ));
    const input = screen.getByRole("combobox", { name: "End time" });
    fireEvent.mouseDown(input);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("11:15 AM (15 mins)");
    expect(options[1]).toHaveTextContent("11:30 AM (30 mins)");
    expect(options[3]).toHaveTextContent("12:00 PM (1 hr)");
    fireEvent.click(screen.getByRole("option", { name: "12:30 PM (1.5 hrs)" }));
    expect(h.value()).toBe(12 * 60 + 30);
  });

  test("Escape closes the list and puts back what was typed, without reaching the parent", () => {
    const h = harness(9 * 60, (value, onChange) => (
      <TimeField aria-label="Start time" value={value} onChange={onChange} />
    ));
    const input = screen.getByRole("combobox", { name: "Start time" });
    fireEvent.change(input, { target: { value: "10" } });
    expect(input).toHaveAttribute("aria-expanded", "true");
    key(input, "Escape");
    expect(input).toHaveValue("9:00 AM");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(h.parentKeys).toEqual([]);
    expect(h.value()).toBe(9 * 60);
  });
});

test("inside a Modal, Escape closes the picker first and the dialog second", () => {
  const onClose = vi.fn();
  render(
    <Modal
      title="Edit"
      titleId="t"
      onClose={onClose}
      className="m"
      scrimClassName="s"
      titleClassName="h"
    >
      <DateField aria-label="Date" value="2026-11-13" onChange={() => {}} />
    </Modal>,
  );
  const field = screen.getByRole("combobox", { name: "Date" });
  field.focus();
  key(field, "Enter");
  expect(screen.getByRole("grid")).toBeInTheDocument();
  key(field, "Escape");
  expect(screen.queryByRole("grid")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(field).toHaveFocus();
  key(field, "Escape");
  expect(onClose).toHaveBeenCalledOnce();
});
