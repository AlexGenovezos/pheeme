import { AlertTriangle, FileUp, FolderOpen, Paintbrush, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { Button } from "../components/ui/Button";
import { toast } from "../components/ui/Toast";
import { openThemeFolder } from "../lib/tauri";
import type { ImportedTheme } from "../styles/themes/t3";
import { openThemeEditor } from "../theme/editor/editorStore";
import { parseThemeText } from "../theme/customThemes";
import {
  type ResolvedTheme,
  type ThemeOption,
  themeFor,
  themeOptions,
  useThemeStore,
} from "../theme/theme";
import { useThemeFolderStore } from "../theme/themeFolder";
import { useSettingsStore } from "./settingsStore";

const KIND_LABEL: Record<ResolvedTheme, string> = { light: "Light", dark: "Dark" };
const SOURCE_GROUP: Record<ThemeOption["source"], string> = {
  "built-in": "Built in",
  custom: "Your themes",
  folder: "Themes folder",
};

/** Open the editor over the app, with Settings out of the way until it closes. */
function editTheme(args: Parameters<typeof openThemeEditor>[0]) {
  useSettingsStore.getState().close();
  openThemeEditor({ ...args, fromSettings: true });
}

/** The theme's background, accent and text as three dots, as T3 Code's theme list shows them. */
function ThemePreviewDots({ kind }: { kind: ResolvedTheme }) {
  const theme = useThemeStore((s) => themeFor(kind, s.choices, s.customThemes, s.folderThemes));
  const dots = ["--color-app-bg", "--color-accent", "--color-foreground"] as const;
  return (
    <span className="settings-theme-dots" aria-hidden>
      {dots.map((token) => (
        <span key={token} style={{ backgroundColor: theme.tokens[token] }} />
      ))}
    </span>
  );
}

/**
 * Pick which theme Light (or Dark) mode uses. Any theme fits either mode, as in
 * T3 Code. A custom theme can be edited or removed from here; any other is
 * copied into a new theme to edit.
 */
export function ThemeChoiceControl({ kind }: { kind: ResolvedTheme }) {
  const customThemes = useThemeStore((s) => s.customThemes);
  const folderThemes = useThemeStore((s) => s.folderThemes);
  const chosen = useThemeStore((s) => s.choices[kind]);
  const chooseTheme = useThemeStore((s) => s.chooseTheme);
  const removeTheme = useThemeStore((s) => s.removeTheme);
  const options = themeOptions(kind, customThemes, folderThemes);
  const selected = options.find((o) => o.id === chosen) ?? options[0];
  const sources = (["built-in", "custom", "folder"] as const).filter((source) =>
    options.some((o) => o.source === source),
  );

  function remove() {
    try {
      removeTheme(selected.id);
      toast({ title: `Removed ${selected.name}` });
    } catch (err) {
      toast({ title: "Couldn't remove the theme", description: String(err), tone: "danger" });
    }
  }

  const custom = selected.source === "custom";
  return (
    <>
      {custom && (
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={14} aria-hidden />}
          aria-label={`Remove ${selected.name}`}
          title={`Remove ${selected.name}`}
          onClick={remove}
        />
      )}
      <Button
        variant="ghost"
        size="sm"
        icon={custom ? <Pencil size={14} aria-hidden /> : <Paintbrush size={14} aria-hidden />}
        aria-label={custom ? `Edit ${selected.name}` : `Customize ${selected.name}`}
        title={custom ? `Edit ${selected.name}` : `Make a copy of ${selected.name} to edit`}
        onClick={() => editTheme({ id: selected.id, slot: kind })}
      />
      <ThemePreviewDots kind={kind} />
      <select
        className="settings-select"
        aria-label={`${KIND_LABEL[kind]} theme`}
        value={selected.id}
        onChange={(e) => chooseTheme(kind, e.target.value)}
      >
        {sources.map((source) => (
          <optgroup key={source} label={SOURCE_GROUP[source]}>
            {options
              .filter((o) => o.source === source)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.kind === kind || source === "built-in"
                    ? o.name
                    : `${o.name} (${KIND_LABEL[o.kind].toLowerCase()})`}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </>
  );
}

export function CreateThemeControl() {
  return (
    <Button icon={<Plus size={14} aria-hidden />} onClick={() => editTheme({})}>
      Create…
    </Button>
  );
}

export function ThemeFolderControl() {
  const failures = useThemeFolderStore((s) => s.failures);
  async function open() {
    try {
      await openThemeFolder();
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      toast({ title: "Couldn't open the themes folder", description: message, tone: "danger" });
    }
  }
  return (
    <>
      {failures.length > 0 && (
        <span
          className="settings-theme-folder-warning"
          title={failures.join("\n")}
          aria-label={`${failures.length} theme ${failures.length === 1 ? "file" : "files"} didn't load: ${failures.join(" ")}`}
        >
          <AlertTriangle size={14} aria-hidden />
          {failures.length === 1 ? "1 file didn't load" : `${failures.length} files didn't load`}
        </span>
      )}
      <Button icon={<FolderOpen size={14} aria-hidden />} onClick={() => void open()}>
        Open folder
      </Button>
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

/** Read the picked files; each is a Pheeme, VS Code or T3 Code theme (a T3 file can hold two). */
export async function readThemeFiles(
  files: Iterable<File>,
): Promise<{ themes: ImportedTheme[]; failures: string[] }> {
  const themes: ImportedTheme[] = [];
  const failures: string[] = [];
  for (const file of files) {
    try {
      themes.push(...parseThemeText(await readText(file), file.name));
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
              ? `Installed ${themes[0].file.name}`
              : `Installed ${themes.length} themes`,
          description:
            themes.length === 1
              ? `Pheeme uses it in ${KIND_LABEL[themes[0].slot]} mode.`
              : themes.map((t) => t.file.name).join(", "),
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
