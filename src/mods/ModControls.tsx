import { useState } from "react";
import { Button } from "../components/ui/Button";
import { Switch } from "../components/ui/Switch";
import { useModStore } from "./store";
import { type ModBlock, modAction } from "./api";
import { reportModError } from "./lifecycle";
import "./mods.css";

export function ModControls({ id, blocks }: { id: string; blocks: ModBlock[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function run(action: string, value: unknown = null) {
    setBusy(action);
    try {
      await modAction(id, action, value);
    } catch (error) {
      reportModError(error);
    } finally {
      await useModStore.getState().load();
      setBusy(null);
    }
  }
  return (
    <div className="mod-controls" data-owns-keys>
      {blocks.map((block, index) => {
        if (block.type === "text")
          return (
            <p key={`text:${index}`} className="mod-text">
              {block.text}
            </p>
          );
        if (block.type === "button")
          return (
            <Button
              key={block.id}
              size="sm"
              disabled={block.disabled || busy !== null}
              onClick={() => void run(block.id)}
            >
              {block.label}
            </Button>
          );
        if (block.type === "toggle")
          return (
            <label key={block.id} className="mod-field">
              <span>{block.label}</span>
              <Switch
                label={block.label}
                checked={block.value}
                disabled={busy !== null}
                onChange={(value) => void run(block.id, value)}
              />
            </label>
          );
        return (
          <ModInput
            key={block.id}
            block={block}
            disabled={busy !== null}
            onSave={(value) => void run(block.id, value)}
          />
        );
      })}
    </div>
  );
}

function ModInput({
  block,
  disabled,
  onSave,
}: {
  block: Extract<ModBlock, { type: "input" }>;
  disabled: boolean;
  onSave(value: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <form
      className="mod-field"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft ?? block.value);
        setDraft(null);
      }}
    >
      <label className="mod-input-label">
        {block.label}
        <input
          className="mod-input"
          value={draft ?? block.value}
          maxLength={2000}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <Button size="sm" type="submit" disabled={disabled || draft === null}>
        Save
      </Button>
    </form>
  );
}
