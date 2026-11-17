// A task's editor, in place of its row: also the field a new task is typed into.
import { X } from "lucide-react";
import { type FocusEvent, type KeyboardEvent, useRef, useState } from "react";
import { useCalendarStore, weekStartOf } from "../calendar/calendarStore";
import { Button } from "../components/ui/Button";
import { DateField } from "../components/ui/DateField";
import { IconButton } from "../components/ui/IconButton";
import type { Task, TaskEdit } from "../lib/tauri";
import { newTaskKey, type Placement, taskKey, taskTitle } from "./outline";
import { useTasksStore } from "./tasksStore";

const store = useTasksStore.getState;

/**
 * A task's title, details and due date, edited in place. Enter in the title or leaving the editor
 * saves (a new task's Enter opens another one under it); Escape saves and closes, as in Google
 * Tasks. An empty new task is dropped.
 */
export function TaskEditor({
  accountId,
  listId,
  task,
  placement,
  editKey,
}: {
  accountId: string;
  listId: string;
  task?: Task;
  placement?: Placement;
  /** The `editing` key that opened it, when not the task's own (Today). */
  editKey?: string;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [due, setDue] = useState(task?.due ?? "");
  const done = useRef(false);
  const dateRef = useRef<HTMLButtonElement>(null);
  const weekStart = useCalendarStore((s) => weekStartOf(s.accounts));

  const save = async (another: boolean) => {
    if (done.current) return;
    done.current = true;
    const close = () => {
      if (useTasksStore.getState().editing === current) store().setEditing(null);
    };
    if (task) {
      const edit: TaskEdit = {};
      if (title !== task.title) edit.title = title;
      if (notes !== (task.notes ?? "")) edit.notes = notes;
      if (due !== (task.due ?? "")) edit.due = due;
      close();
      if (Object.keys(edit).length > 0) await store().editTask(task, edit);
      return;
    }
    if (!title.trim() && !notes.trim() && !due) return close();
    const edit: TaskEdit = { title: title.trim() };
    if (notes.trim()) edit.notes = notes;
    if (due) edit.due = due;
    const created = await store().addTask(accountId, listId, edit, placement);
    if (!created) {
      // Not added (offline, or Google refused; the toast says why): keep the editor open with what
      // was typed, so Enter or leaving it again tries again.
      done.current = false;
      return;
    }
    if (another && useTasksStore.getState().editing === current)
      store().setEditing(
        newTaskKey(accountId, listId, { parent: placement?.parent ?? null, previous: created.id }),
      );
    else close();
  };
  const current =
    editKey ??
    (task
      ? taskKey(task)
      : newTaskKey(accountId, listId, placement ?? { parent: null, previous: null }));

  const onBlur = (e: FocusEvent<HTMLFormElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void save(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void save(false);
    }
  };

  return (
    <form
      className="task-editor"
      aria-label={task ? `Edit task: ${taskTitle(task)}` : "New task"}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void save(!task);
      }}
    >
      <span className="task-check task-check--placeholder" aria-hidden="true">
        <span className="task-check__ring" />
      </span>
      <div className="task-editor__fields">
        <input
          autoFocus
          className="task-editor__title"
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <textarea
          className="task-editor__notes"
          aria-label="Details"
          placeholder="Details"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
        <span className="task-editor__due">
          <DateField
            ref={dateRef}
            className="task-editor__date"
            aria-label="Due date"
            placeholder="Add a due date"
            value={due}
            weekStart={weekStart}
            onChange={setDue}
          />
          <IconButton
            size="sm"
            label="Remove due date"
            icon={<X />}
            disabled={!due}
            onClick={() => {
              setDue("");
              dateRef.current?.focus();
            }}
          />
        </span>
        {/* Enter submits from the title; the button is for pointer users. */}
        <span className="task-editor__actions">
          <Button type="submit" size="sm" variant="primary">
            {task ? "Done" : "Add"}
          </Button>
        </span>
      </div>
    </form>
  );
}
