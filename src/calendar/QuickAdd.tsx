// Quick add (`c`, Create): type "Meet with Kevin tomorrow at 9 am" and see the event before adding
// it. The words read as the time, repeat, place, people and calendar are highlighted as you type;
// each "with" name offers the matching contacts, and only a picked one is invited. "todo …" adds a
// Google Task instead. Rules and chrono-node only (`sentence.ts`), no AI.
import { CalendarDays, CheckSquare, Clock, MapPin, Repeat, Users, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { type ContactSuggestion, suggestContacts } from "../lib/tauri";
import { useTasksStore } from "../tasks/tasksStore";
import {
  closeQuickAdd,
  defaultCalendar,
  defaultTimes,
  openFormInEditor,
  saveQuickAdd,
  saveQuickTask,
  writableCalendars,
} from "./actions";
import { displayZone, useCalendarStore } from "./calendarStore";
import { dateOf, formatDay, formatTime, weekday } from "./dates";
import { useEditStore } from "./editStore";
import { CalendarSelect } from "./EventFields";
import { describeRule, type EventForm, type Guest, newForm, WEEKDAYS } from "./eventForm";
import { parseQuickAdd, type Person, type Span, type Target } from "./sentence";

export function QuickAdd() {
  const open = useEditStore((s) => s.quickAdd);
  return open ? <QuickAddDialog /> : null;
}

const key = (accountId: string, id: string) => `${accountId}\n${id}`;
const lower = (s: string) => s.toLowerCase();

/** The sentence with what was read highlighted, drawn under the (transparent) field. */
function Highlights({ text, spans }: { text: string; spans: Span[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    if (s.start > at) parts.push(text.slice(at, s.start));
    parts.push(
      <mark key={s.start} className={`cal-qa__mark cal-qa__mark--${s.kind}`}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * Contacts matching each name after "with" (and each name with the word after it, "mike murray"),
 * per account: `undefined` while being looked up.
 */
function useMatches(accountId: string, people: Person[]) {
  const [matches, setMatches] = useState<Record<string, ContactSuggestion[]>>({});
  const names = people
    .filter((p) => !p.address)
    .flatMap((p) => (p.full ? [p.text, p.full] : [p.text]))
    .map(lower);
  const wanted = names.filter((n) => !(key(accountId, n) in matches)).join("\n");
  useEffect(() => {
    if (!wanted) return;
    // Wait for typing to pause, so "K", "Ke", "Kev" aren't each looked up.
    const timer = setTimeout(() => {
      for (const name of wanted.split("\n"))
        void suggestContacts(accountId, name, 5)
          .catch(() => [] as ContactSuggestion[])
          // Kept even if typing moved on: it's still who that name is.
          .then((found) => setMatches((m) => ({ ...m, [key(accountId, name)]: found ?? [] })));
    }, 150);
    return () => clearTimeout(timer);
  }, [accountId, wanted]);
  return (name: string): ContactSuggestion[] | undefined => matches[key(accountId, lower(name))];
}

function QuickAddDialog() {
  const titleId = useId();
  const accounts = useCalendarStore((s) => s.accounts);
  const taskAccounts = useTasksStore((s) => s.accounts);
  const tz = displayZone(accounts);
  const [text, setText] = useState("");
  /** "Tomorrow" and "at 5" are read from when the box opened. */
  const [now] = useState(() => Date.now());
  /** The calendar or task list picked from the menu (`/name` in the sentence wins). */
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedList, setPickedList] = useState<string | null>(null);
  /** Who each "with" name is: an address, or "" for nobody. Unset: an address typed is invited, a name isn't. */
  const [who, setWho] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const marksRef = useRef<HTMLDivElement>(null);

  const calendars = useMemo(() => writableCalendars(accounts), [accounts]);
  const lists = useMemo(
    () =>
      (taskAccounts ?? [])
        .filter((a) => a.access.status === "on")
        .flatMap((a) => a.lists.map((l) => ({ account: a, list: l }))),
    [taskAccounts],
  );
  const targets: Target[] = useMemo(
    () =>
      calendars.map((w) => ({
        key: key(w.account.accountId, w.calendar.id),
        name: w.calendar.summary,
      })),
    [calendars],
  );
  const taskTargets: Target[] = useMemo(
    () => lists.map((l) => ({ key: key(l.account.accountId, l.list.id), name: l.list.title })),
    [lists],
  );
  /** Read without knowing contacts: which calendar, and the names to look up. */
  const first = useMemo(
    () => parseQuickAdd(text, { now, tz, targets, taskTargets }),
    [text, now, tz, targets, taskTargets],
  );
  const isTask = first.kind === "task";

  const fallback = defaultCalendar();
  const calendarKey =
    (!isTask && first.target) ||
    picked ||
    (fallback ? key(fallback.account.accountId, fallback.calendar.id) : "");
  const [accountId, calendarId] = calendarKey.split("\n");
  const matchesFor = useMatches(accountId ?? "", isTask ? [] : first.people);
  // "with mike murray": "murray" is part of the name once contacts know a Mike Murray.
  const knownFull = first.people
    .filter((p) => p.full && (matchesFor(p.full)?.length ?? 0) > 0)
    .map((p) => lower(p.full!))
    .join("\n");
  const parsed = useMemo(() => {
    if (!knownFull) return first;
    const known = new Set(knownFull.split("\n"));
    return parseQuickAdd(text, {
      now,
      tz,
      targets,
      taskTargets,
      fullNames: (full) => known.has(lower(full)),
    });
  }, [first, knownFull, text, now, tz, targets, taskTargets]);

  const guests: Guest[] = [];
  for (const p of parsed.people) {
    const chosen = who[lower(p.text)] ?? p.address ?? "";
    if (!chosen || guests.some((g) => lower(g.address) === lower(chosen))) continue;
    const name = matchesFor(p.text)?.find((m) => lower(m.address) === lower(chosen))?.name;
    guests.push({ name: name ?? null, address: chosen, optional: false });
  }

  const when = parsed.when;
  const fallbackStart = defaultTimes().start;
  const times = when ?? {
    allDay: false as const,
    start: fallbackStart,
    end: fallbackStart + (parsed.length ?? 60 * 60_000),
  };
  const form: EventForm = {
    ...(times.allDay
      ? newForm({
          accountId,
          calendarId,
          zone: tz,
          allDay: true,
          startDate: times.date,
          endDate: times.lastDate,
        })
      : newForm({
          accountId,
          calendarId,
          zone: tz,
          allDay: false,
          start: times.start,
          end: times.end,
        })),
    summary: parsed.title,
    location: parsed.place,
    guests,
    repeat: { kind: "none" },
  };
  if (parsed.repeat) {
    const rule = parsed.repeat;
    // "weekly" with no day said: the day it starts on.
    const byDay =
      rule.freq === "WEEKLY" && !rule.byDay.length
        ? [WEEKDAYS[weekday(form.startDate)]]
        : rule.byDay;
    form.repeat = { kind: "rule", rule: { ...rule, byDay } };
  }

  const listKey =
    (isTask && parsed.target) ||
    pickedList ||
    (lists[0] ? key(lists[0].account.accountId, lists[0].list.id) : "");
  const due = when ? (when.allDay ? when.date : dateOf(when.start, tz)) : null;

  const syncScroll = () => {
    if (marksRef.current && inputRef.current)
      marksRef.current.scrollLeft = inputRef.current.scrollLeft;
  };
  useEffect(syncScroll, [text]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || !text.trim()) return;
    setSaving(true);
    if (isTask) {
      const [listAccount, listId] = listKey.split("\n");
      if (listId) await saveQuickTask(listAccount, listId, { title: parsed.title, due });
    } else await saveQuickAdd(form);
    setSaving(false);
  };

  const dayLabel = (date: string) =>
    formatDay(date, { weekday: "short", month: "short", day: "numeric" });
  const whenLabel = times.allDay
    ? times.lastDate !== times.date
      ? `${dayLabel(times.date)} – ${dayLabel(times.lastDate)} · All day`
      : `${dayLabel(times.date)} · All day`
    : `${dayLabel(dateOf(times.start, tz))} · ${formatTime(times.start, tz)} – ${formatTime(times.end, tz)}`;

  return (
    <Modal
      title="Quick add"
      titleId={titleId}
      onClose={closeQuickAdd}
      scrimClassName="cal-qa-scrim"
      className="cal-qa"
      titleClassName="cal-qa__heading"
      titleActions={<IconButton size="sm" label="Close" icon={<X />} onClick={closeQuickAdd} />}
    >
      <form onSubmit={(e) => void submit(e)}>
        <div className="cal-qa__field">
          <div ref={marksRef} className="cal-qa__marks" aria-hidden="true">
            <Highlights text={text} spans={parsed.spans} />
          </div>
          <input
            ref={inputRef}
            className="cal-qa__input"
            aria-label="Event, in words"
            placeholder="Lunch with Sam Friday at noon at Joe's"
            spellCheck={false}
            autoComplete="off"
            data-autofocus=""
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onScroll={syncScroll}
            onSelect={syncScroll}
          />
        </div>

        <div className="cal-qa__preview" aria-live="polite">
          <div className="cal-qa__title">
            {isTask ? <CheckSquare aria-hidden="true" /> : <CalendarDays aria-hidden="true" />}
            <span className={parsed.title ? undefined : "cal-qa__empty"}>
              {parsed.title || (isTask ? "New task" : "New event")}
            </span>
          </div>
          <Row icon={<Clock />} label={isTask ? "Due" : "When"}>
            {isTask ? (
              due ? (
                dayLabel(due)
              ) : (
                <span className="cal-qa__empty">No due date</span>
              )
            ) : (
              <>
                {whenLabel}
                {!when && (
                  <span className="cal-qa__empty"> · add a time, like “tomorrow at 3”</span>
                )}
              </>
            )}
          </Row>
          {!isTask && (
            <>
              <Row icon={<Repeat />} label="Repeat">
                {form.repeat.kind === "rule" ? (
                  describeRule(form.repeat.rule)
                ) : (
                  <span className="cal-qa__empty">Doesn't repeat</span>
                )}
              </Row>
              <Row icon={<MapPin />} label="Place">
                {parsed.place || <span className="cal-qa__empty">Add a place with “at …”</span>}
              </Row>
              <Row icon={<Users />} label="Guests">
                {parsed.people.length === 0 ? (
                  <span className="cal-qa__empty">Invite people with “with …”</span>
                ) : (
                  <div className="cal-qa__people">
                    {parsed.people.map((p) => (
                      <PersonPick
                        key={lower(p.text)}
                        person={p}
                        matches={p.address ? [] : matchesFor(p.text)}
                        value={who[lower(p.text)] ?? p.address ?? ""}
                        onChange={(address) => setWho((w) => ({ ...w, [lower(p.text)]: address }))}
                      />
                    ))}
                  </div>
                )}
              </Row>
            </>
          )}
          <Row icon={<CalendarDays />} label={isTask ? "List" : "Calendar"}>
            {isTask ? (
              <Select
                className="cal-select"
                aria-label="Task list"
                value={listKey}
                placeholder="No task lists"
                onChange={setPickedList}
                options={lists.map((l) => ({
                  value: key(l.account.accountId, l.list.id),
                  label: lists.some((o) => o.account.accountId !== l.account.accountId)
                    ? `${l.list.title} (${l.account.email})`
                    : l.list.title,
                }))}
              />
            ) : (
              <CalendarSelect
                form={form}
                onChange={(f) => setPicked(key(f.accountId, f.calendarId))}
              />
            )}
          </Row>
        </div>

        <div className="cal-qa__actions">
          <span className="cal-qa__hint">
            Try “every other Tue at 10”, “/work”, or start with “todo”
          </span>
          {!isTask && (
            <Button size="sm" variant="ghost" onClick={() => openFormInEditor(form)}>
              More options
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={saving || !text.trim() || (isTask && !listKey)}
          >
            {saving ? "Adding…" : isTask ? "Add task" : "Add event"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="cal-qa__row">
      <span className="cal-qa__icon" title={label} aria-label={label}>
        {icon}
      </span>
      <div className="cal-qa__value">{children}</div>
    </div>
  );
}

/** Who "Kevin" is: one of the matching contacts, or nobody (no invite). */
function PersonPick({
  person,
  matches,
  value,
  onChange,
}: {
  person: Person;
  matches: ContactSuggestion[] | undefined;
  value: string;
  onChange(address: string): void;
}) {
  if (person.address)
    return (
      <label className="cal-qa__person cal-check">
        <input
          type="checkbox"
          checked={value !== ""}
          onChange={(e) => onChange(e.currentTarget.checked ? person.address! : "")}
        />
        Invite {person.address}
      </label>
    );
  return (
    <div className="cal-qa__person">
      <span className="cal-qa__name">{person.text}</span>
      <Select
        className="cal-select"
        aria-label={`Who ${person.text} is`}
        value={value}
        disabled={!matches || matches.length === 0}
        onChange={onChange}
        options={[
          {
            value: "",
            label:
              matches === undefined
                ? "Looking up contacts…"
                : matches.length === 0
                  ? "No matching contact"
                  : "Don't invite",
          },
          ...(matches ?? []).map((m) => ({
            value: m.address,
            label: m.name ? `${m.name} <${m.address}>` : m.address,
          })),
        ]}
      />
    </div>
  );
}
