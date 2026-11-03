import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/utils";
import "./TextInput.css";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  leading?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
  /** `lg` matches `lg` buttons on full-page screens (onboarding, accounts). */
  size?: "md" | "lg";
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { leading, trailing, invalid, size = "md", className, type = "text", ...rest },
  ref,
) {
  return (
    <span
      className={cx(
        "ui-input",
        size === "lg" && "ui-input--lg",
        invalid && "ui-input--invalid",
        className,
      )}
    >
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
