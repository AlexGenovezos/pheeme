// An account's task lists in the calendar sidebar, under its calendars: the tick says whether the
// list's dated tasks show on the grid (a local choice, like hiding a calendar).
import { Check, ListChecks } from "lucide-react";
import { useTasksStore } from "./tasksStore";
import "./tasks.css";

export function SidebarTaskLists({ accountId }: { accountId: string }) {
  const account = useTasksStore((s) => s.accounts?.find((a) => a.accountId === accountId));
  if (!account || account.access.status !== "on" || account.lists.length === 0) return null;
  return (
    <ul className="cal-sidebar__tasks" aria-label={`Task lists of ${account.email}`}>
      {account.lists.map((list) => {
        const shown = !list.hidden;
        return (
          <li key={list.id}>
            <label className="cal-sidebar__calendar" title={list.title}>
              <input
                type="checkbox"
                className="cal-sidebar__check-input"
                aria-label={`Tasks: ${list.title}`}
                checked={shown}
                onChange={(e) =>
                  void useTasksStore
                    .getState()
                    .setListHidden(accountId, list.id, !e.currentTarget.checked)
                }
              />
              <span
                className="cal-sidebar__check cal-sidebar__check--tasks"
                data-checked={shown || undefined}
                aria-hidden="true"
              >
                {shown && <Check />}
              </span>
              <span className="cal-sidebar__calendar-name">{list.title}</span>
              <ListChecks className="cal-sidebar__tasks-icon" aria-hidden="true" />
            </label>
          </li>
        );
      })}
    </ul>
  );
}
