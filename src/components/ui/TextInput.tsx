import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/utils";
import "./TextInput.css";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  leading?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { leading, trailing, invalid, className, type = "text", ...rest },
  ref,
) {
  return (
    <span className={cx("ui-input", invalid && "ui-input--invalid", className)}>
      {leading && <span className="ui-input__adornment">{leading}</span>}
      <input
        ref={ref}
        type={type}
        className="ui-input__field"
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        {...rest}
      />
      {trailing && <span className="ui-input__adornment">{trailing}</span>}
    </span>
  );
});
