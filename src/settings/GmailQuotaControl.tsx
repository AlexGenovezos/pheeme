import { useEffect, useRef, useState } from "react";
import { TextInput } from "../components/ui/TextInput";
import { getGmailQuota, setGmailQuota, toCommandError } from "../lib/tauri";

const format = (n: number) => n.toLocaleString("en-US");
/** A whole number typed with or without separators, else null. */
const parse = (text: string) => {
  const typed = text.replace(/[,\s]/g, "");
  return /^\d+$/.test(typed) ? Number(typed) : null;
};

/** Gmail's per-user limit in units per minute. Saved on Enter or when the field loses focus. */
export function GmailQuotaControl() {
  const [saved, setSaved] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Read by saves that outlive a render: the field's latest text, the stored value, whether a
  // save is in flight, and the text of a save asked for meanwhile (it runs next).
  const draft = useRef("");
  const stored = useRef<number | null>(null);
  const saving = useRef(false);
  const queued = useRef<string | null>(null);
  const edit = (next: string) => {
    draft.current = next;
    setText(next);
  };
  const store = (value: number) => {
    stored.current = value;
    setSaved(value);
  };

  useEffect(() => {
    let stopped = false;
    getGmailQuota().then(
      (value) => {
        if (stopped) return;
        store(value);
        edit(format(value));
      },
      (raw) => {
        if (!stopped) setError(toCommandError(raw).message);
      },
    );
    return () => {
      stopped = true;
    };
  }, []);

  const value = parse(text);

  async function save(submitted = draft.current) {
    if (saving.current) {
      queued.current = submitted;
      return;
    }
    const wanted = parse(submitted);
    if (wanted === null || wanted === stored.current) {
      if (wanted !== null && draft.current === submitted) edit(format(wanted));
      return;
    }
    saving.current = true;
    setError(null);
    try {
      const result = await setGmailQuota(wanted);
      store(result);
      // Typed over while saving: keep the new draft.
      if (draft.current === submitted) edit(format(result));
    } catch (raw) {
      setError(toCommandError(raw).message);
    } finally {
      saving.current = false;
    }
    const next = queued.current;
    queued.current = null;
    if (next !== null) await save(next);
  }

  return (
    <TextInput
      aria-label="Gmail API limit"
      title={error ?? undefined}
      inputMode="numeric"
      value={text}
      disabled={saved === null && error === null}
      invalid={(text !== "" && value === null) || error !== null}
      trailing="/ min"
      onChange={(e) => edit(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void save();
      }}
      className="settings-quota"
    />
  );
}
