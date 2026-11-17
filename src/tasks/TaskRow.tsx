// One task in a list: tick it off, open it for editing, drag it by its grip, and the menu to indent, move and delete.
import { Check, GripVertical, MoreHorizontal } from "lucide-react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { dateOf, systemZone } from "../calendar/dates";
import { IconButton } from "../components/ui/IconButton";
import {
  type ContextMenuItem,
  isContextMenuKey,
  openContextMenuAt,
  openContextMenuFromEvent,
  showContextMenu,
} from "../lib/contextMenu";
import type { Task, TaskListInfo } from "../lib/tauri";
import { cx } from "../lib/utils";
import {
  dueLabel,
  indentPlacement,
  outdentPlacement,
  type Placement,
  stepPlacement,
  taskKey,
  taskTitle,
} from "./outline";
import { bookTask } from "./planStore";
import { useTasksStore } from "./tasksStore";

const store = useTasksStore.getState;
const today = () => dateOf(Date.now(), systemZone());

export function TaskRow({
  task,
  open,
  otherLists,
  onAddSubtask,
  onGripPointerDown,
  editKey = taskKey(task),
}: {
  task: Task;
  /** The list's open tasks, for indenting and moving. */
  open: Task[];
  otherLists: TaskListInfo[];
  onAddSubtask?: () => void;
  /** Starts dragging the task into another place. */
  onGripPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  /** What `editing` becomes to open its editor (the task's key; Today has its own). */
  editKey?: string;
}) {
  const title = taskTitle(task);
  const now = today();
  const move = (p: Placement | null) => p && void store().moveTask(task, p);
  const indent = task.completed ? null : indentPlacement(open, task);
  const outdent = task.completed ? null : outdentPlacement(task);
  const up = task.completed ? null : stepPlacement(open, task, -1);
  const down = task.completed ? null : stepPlacement(open, task, 1);

  const items: ContextMenuItem[] = [
    ...(task.completed
      ? []
      : ([
          ...(onAddSubtask && !task.parent
            ? [{ id: "subtask", label: "Add a subtask", onSelect: onAddSubtask }]
            : []),
          { id: "indent", label: "Indent", disabled: !indent, onSelect: () => move(indent) },
          { id: "outdent", label: "Outdent", disabled: !outdent, onSelect: () => move(outdent) },
          { id: "up", label: "Move up", disabled: !up, onSelect: () => move(up) },
          { id: "down", label: "Move down", disabled: !down, onSelect: () => move(down) },
          { type: "separator" },
          {
            id: "book",
            label: "Book a time",
            // On its day if that's still ahead, else today.
            onSelect: () => void bookTask(task, task.due && task.due > now ? task.due : now),
          },
        ] satisfies ContextMenuItem[])),
    ...(otherLists.length > 0 && !task.parent
      ? ([
          { type: "separator" },
          ...otherLists.map((l) => ({
            id: `move-${l.id}`,
            label: `Move to ${l.title}`,
            onSelect: () => void store().moveToList(task, l.id),
          })),
        ] satisfies ContextMenuItem[])
      : []),
    { type: "separator" },
    { id: "delete", label: "Delete", danger: true, onSelect: () => void store().deleteTask(task) },
  ];

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    let placement: Placement | null = null;
    if (isContextMenuKey(e)) {
      e.preventDefault();
      openContextMenuAt(e.currentTarget, items);
      return;
    }
    if (mod && e.key === "]") placement = indent;
    else if (mod && e.key === "[") placement = outdent;
    else if (mod && e.key === "ArrowUp") placement = up;
    else if (mod && e.key === "ArrowDown") placement = down;
    else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      void store().deleteTask(task);
      return;
    } else return;
    e.preventDefault();
    move(placement);
  };

  return (
    <div
      className={cx("task-row", task.completed && "task-row--done")}
      onContextMenu={(e) => openContextMenuFromEvent(e, items)}
      onKeyDown={onKeyDown}
    >
      {!task.completed && (
        <span className="task-row__grip" aria-hidden="true" onPointerDown={onGripPointerDown}>
          <GripVertical />
        </span>
      )}
      <button
        type="button"
        role="checkbox"
        aria-checked={task.completed}
        aria-label={task.completed ? `Mark not done: ${title}` : `Mark done: ${title}`}
        className="task-check"
        onClick={() => void store().setCompleted(task, !task.completed)}
      >
        <span className="task-check__ring">
          <Check aria-hidden="true" />
        </span>
      </button>
      <button
        type="button"
        className="task-row__main"
        aria-label={`Edit task: ${title}`}
        onClick={() => store().setEditing(editKey)}
      >
        <span className="task-row__title">{title}</span>
        {task.notes && <span className="task-row__notes">{task.notes}</span>}
        {task.due && (
          <span
            className={cx(
              "task-row__due",
              !task.completed && task.due < now && "task-row__due--overdue",
            )}
          >
            {dueLabel(task.due, now)}
          </span>
        )}
      </button>
      <IconButton
        size="sm"
        className="task-row__menu"
        label={`Task options: ${title}`}
        icon={<MoreHorizontal />}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          void showContextMenu(items, { x: r.left, y: r.bottom });
        }}
      />
    </div>
  );
}
