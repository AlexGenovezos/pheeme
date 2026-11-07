import { FileUp, Trash2 } from "lucide-react";
import { useRef } from "react";
import { Button } from "../components/ui/Button";
import { toast } from "../components/ui/Toast";
import type { ThemeFile } from "../styles/themes/themeFile";
import { parseThemeText } from "../theme/customThemes";
import { type ResolvedTheme, themeOptions, useThemeStore } from "../theme/theme";

const KIND_LABEL: Record<ResolvedTheme, string> = { light: "Light", dark: "Dark" };

/** Pick which theme Light (or Dark) mode uses; a custom theme can be removed from here. */
export function ThemeChoiceControl({ kind }: { kind: ResolvedTheme }) {
  const customThemes = useThemeStore((s) => s.customThemes);
  const chosen = useThemeStore((s) => s.choices[kind]);
  const chooseTheme = useThemeStore((s) => s.chooseTheme);
  const removeTheme = useThemeStore((s) => s.removeTheme);
  const options = themeOptions(kind, customThemes);
  const selected = options.find((o) => o.id === chosen) ?? options[0];

  function remove() {
    try {
      removeTheme(selected.id);
      toast({ title: `Removed ${selected.name}` });
    } catch (err) {
      toast({ title: "Couldn't remove the theme", description: String(err), tone: "danger" });
    }
  }

  return (
    <>
      {selected.custom && (
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={14} aria-hidden />}
          aria-label={`Remove ${selected.name}`}
          title={`Remove ${selected.name}`}
          onClick={remove}
        />
      )}
      <select
        className="settings-select"
        aria-label={`${KIND_LABEL[kind]} theme`}
        value={selected.id}
        onChange={(e) => chooseTheme(kind, e.target.value)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </>
  );
}

/** A file's text. FileReader rather than Blob.text(), which older macOS webviews (Safari 13) lack. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read."));
    reader.readAsText(file);
  });
}

/** Read the picked files; each is a Pheeme theme file or a VS Code color theme. */
export async function readThemeFiles(
  files: Iterable<File>,
): Promise<{ themes: ThemeFile[]; failures: string[] }> {
  const themes: ThemeFile[] = [];
  const failures: string[] = [];
  for (const file of files) {
    try {
      themes.push(parseThemeText(await readText(file), file.name));
    } catch (err) {
      failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { themes, failures };
}

export function ImportThemeControl() {
  const input = useRef<HTMLInputElement>(null);
  const installThemes = useThemeStore((s) => s.installThemes);

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    const { themes, failures } = await readThemeFiles(Array.from(files));
    if (input.current) input.current.value = ""; // picking the same file again still fires
    try {
      installThemes(themes);
      if (themes.length)
        toast({
          title:
            themes.length === 1
              ? `Installed ${themes[0].name}`
              : `Installed ${themes.length} themes`,
          description:
            themes.length === 1
              ? `Pheeme uses it in ${KIND_LABEL[themes[0].kind]} mode.`
              : themes.map((t) => t.name).join(", "),
        });
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
    if (failures.length)
      toast({
        title: failures.length === 1 ? "Couldn't import the theme" : "Some themes didn't import",
        description: failures.join(" "),
        tone: "danger",
        duration: 0,
      });
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,.jsonc,application/json"
        multiple
        hidden
        data-testid="theme-file-input"
        onChange={(e) => void onPick(e.target.files)}
      />
      <Button icon={<FileUp size={14} aria-hidden />} onClick={() => input.current?.click()}>
        Import…
      </Button>
    </>
  );
}
