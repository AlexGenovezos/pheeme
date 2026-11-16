import { ANSWERS, type Answer } from "./rsvp";

/** The user's own Yes / Maybe / No, in the event popover and the email invite card. */
export function AnswerRadios({
  shown,
  pending,
  onChoose,
}: {
  /** The answer to show as chosen (the one being sent, else the current one). */
  shown: string | null | undefined;
  /** An answer is being sent: clicks do nothing until it settles. */
  pending: boolean;
  onChoose: (answer: Answer) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Your answer" className="cal-pop__answers">
      {ANSWERS.map((a) => (
        <button
          key={a.value}
          type="button"
          role="radio"
          aria-checked={shown === a.value}
          className="cal-pop__answer"
          // Not `disabled`: a disabled button drops focus, and the user answered from it.
          aria-disabled={pending}
          onClick={() => {
            if (!pending) onChoose(a.value);
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
