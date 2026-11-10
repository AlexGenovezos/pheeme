// A dropdown that looks the same on every OS: a button showing the chosen option and a listbox
// under it (the ARIA "select-only combobox"). Arrows, Home/End and PageUp/PageDown move, Enter or
// Space chooses, Escape closes (only the list, never the dialog it's in), and typing jumps to an
// option by its first letters, closed or open.
import { ChevronDown } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "../../lib/utils";
import {
  edge,
  focusOnPress,
  isPrintable,
  Listbox,
  type ListOption,
  PickerPopover,
  revealOption,
  step,
  useTypeahead,
} from "./Picker";

export interface SelectOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Options with the same `group` next to each other are listed under that heading. */
  group?: string;
}

export interface SelectProps<T> extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "onChange" | "children" | "type"
> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange(value: T): void;
  /** Shown when `value` isn't one of the options. */
  placeholder?: string;
}

export function Select<T>({
  value,
  options,
  onChange,
  placeholder = "",
  className,
  disabled,
  onKeyDown: onKeyDownProp,
  ...rest
}: SelectProps<T>) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-o${i}`;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const chosen = options.findIndex((o) => Object.is(o.value, value));
  const labels = useMemo(() => options.map((o) => o.label), [options]);
  const disabledList = useMemo(() => options.map((o) => !!o.disabled), [options]);
  const typeahead = useTypeahead(labels, disabledList);
  const spaceHandled = useRef(false);

  const list: ListOption[] = options.map((o, i) => ({
    id: optionId(i),
    label: o.label,
    disabled: o.disabled,
    selected: i === chosen,
    group: o.group,
  }));

  const move = (i: number, block: ScrollLogicalPosition = "nearest") => {
    if (i < 0) return;
    setActive(i);
    revealOption(optionId(i), block);
  };
  const show = (at: number) => {
    setOpen(true);
    setActive(at);
    // The list renders this frame; centre the active option once it's there.
    requestAnimationFrame(() => revealOption(optionId(at), "center"));
  };
  const close = useCallback(() => setOpen(false), []);
  const choose = (i: number) => {
    const option = options[i];
    if (!option || option.disabled) return;
    setOpen(false);
    if (!Object.is(option.value, value)) onChange(option.value);
  };
  const startAt = chosen >= 0 && !options[chosen].disabled ? chosen : edge(options, 1);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDownProp?.(e);
    if (e.defaultPrevented || disabled) return;
    const key = e.key;
    if (isPrintable(e) && (key !== " " || typeahead.typing())) {
      const at = typeahead.find(key, open ? active : chosen);
      if (at >= 0) {
        if (open) move(at);
        else show(at);
      }
    } else if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        if (key === " ") spaceHandled.current = true;
        show(startAt);
      } else if (key === "Home" || key === "End") show(edge(options, key === "Home" ? 1 : -1));
      else return;
    } else {
      switch (key) {
        case "ArrowDown":
          if (e.altKey) choose(active);
          else move(step(options, active, 1));
          break;
        case "ArrowUp":
          if (e.altKey) choose(active);
          else move(step(options, active, -1));
          break;
        case "PageDown":
          move(step(options, active, 10));
          break;
        case "PageUp":
          move(step(options, active, -10));
          break;
        case "Home":
          move(edge(options, 1));
          break;
        case "End":
          move(edge(options, -1));
          break;
        case " ":
          spaceHandled.current = true;
          choose(active);
          break;
        case "Enter":
          choose(active);
          break;
        case "Escape":
          close();
          break;
        case "Tab":
          close();
          return;
        default:
          return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const shown = chosen >= 0 ? options[chosen].label : placeholder;
  return (
    <>
      <button
        {...rest}
        ref={ref}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        disabled={disabled}
        className={cx("ui-field ui-select", className)}
        onMouseDown={(e) => {
          rest.onMouseDown?.(e);
          focusOnPress(e);
        }}
        onClick={() => (open ? close() : show(startAt))}
        onKeyDown={onKeyDown}
        // A Space that opened or chose mustn't also click the button (Firefox clicks on keyup).
        onKeyUp={(e) => {
          if (e.key === " " && spaceHandled.current) {
            spaceHandled.current = false;
            e.preventDefault();
          }
        }}
        onBlur={close}
      >
        <span className={cx("ui-field__value", chosen < 0 && "ui-field__value--placeholder")}>
          {shown}
        </span>
        <span className="ui-field__icon" aria-hidden="true">
          <ChevronDown />
        </span>
      </button>
      {open && (
        <PickerPopover anchor={ref} onClose={close} className="ui-picker--list" matchWidth>
          <Listbox
            id={listId}
            label={rest["aria-label"]}
            options={list}
            active={active}
            onActive={setActive}
            onPick={choose}
          />
        </PickerPopover>
      )}
    </>
  );
}
