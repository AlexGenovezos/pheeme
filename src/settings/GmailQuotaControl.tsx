import { useEffect, useState } from "react";
import { TextInput } from "../components/ui/TextInput";
import { getGmailQuota, setGmailQuota, toCommandError } from "../lib/tauri";

const format = (n: number) => n.toLocaleString("en-US");

/** Gmail's per-user limit in units per minute. Saved on Enter or when the field loses focus. */
export function GmailQuotaControl() {
  const [saved, setSaved] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    getGmailQuota().then(
      (value) => {
        if (stopped) return;
        setSaved(value);
        setText(format(value));
      },
      (raw) => {
        if (!stopped) setError(toCommandError(raw).message);
      },
    );
    return () => {
      stopped = true;
    };
  }, []);

  const typed = text.replace(/[,\s]/g, "");
  const value = /^\d+$/.test(typed) ? Number(typed) : null;

  async function save() {
    if (value === null || value === saved) {
      if (value !== null && saved !== null) setText(format(saved));
      return;
    }
    setError(null);
    try {
      const stored = await setGmailQuota(value);
      setSaved(stored);
      setText(format(stored));
    } catch (raw) {
      setError(toCommandError(raw).message);
    }
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
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void save();
      }}
      className="settings-quota"
    />
  );
}
