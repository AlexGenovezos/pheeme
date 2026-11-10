// The questions a change can need first, as on the website: which events of a repeating series
// ("This event / This and following events / All events") and whether to email the guests.
import { type FormEvent, useId, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { type PromptSpec, useEditStore } from "./editStore";

export function EditPrompt() {
  const prompt = useEditStore((s) => s.prompt);
  return prompt ? <PromptBody key={prompt.title} prompt={prompt} /> : null;
}

function PromptBody({ prompt }: { prompt: PromptSpec }) {
  const titleId = useId();
  const [choice, setChoice] = useState(prompt.options[0]?.value ?? "");
  const cancel = () => prompt.resolve(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    prompt.resolve(choice);
  };
  return (
    <Modal
      title={prompt.title}
      titleId={titleId}
      onClose={cancel}
      scrimClassName="cal-dialog-scrim"
      className="cal-prompt"
      titleClassName="cal-prompt__title"
    >
      {prompt.message && <p className="cal-prompt__message">{prompt.message}</p>}
      {prompt.kind === "choice" ? (
        <form className="cal-prompt__form" onSubmit={submit}>
          <div role="radiogroup" aria-labelledby={titleId} className="cal-prompt__choices">
            {prompt.options.map((o, i) => (
              <label key={o.value} className="cal-check">
                <input
                  type="radio"
                  name="cal-prompt"
                  value={o.value}
                  checked={choice === o.value}
                  data-autofocus={i === 0 ? "" : undefined}
                  onChange={() => setChoice(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
          <div className="cal-prompt__actions">
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit">
              OK
            </Button>
          </div>
        </form>
      ) : (
        <div className="cal-prompt__actions">
          {prompt.options.map((o, i) => {
            const last = i === prompt.options.length - 1;
            return (
              <Button
                key={o.value}
                size="sm"
                variant={last ? "primary" : i === 0 ? "ghost" : "secondary"}
                data-autofocus={last ? "" : undefined}
                onClick={() => prompt.resolve(o.value)}
              >
                {o.label}
              </Button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
