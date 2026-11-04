import { Puzzle, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { useSettingsStore } from "../settings/settingsStore";
import { ModControls } from "./ModControls";
import { useModStore } from "./store";

export function ModSidebar() {
  const mods = useModStore((s) => s.mods);
  const running = mods.filter((m) => m.running);
  if (!running.length) return null;
  return (
    <section className="mod-sidebar" aria-label="Mods">
      {running.map((mod) => (
        <div key={mod.manifest.id} className="mod-sidebar-entry">
          <Button
            size="sm"
            variant="ghost"
            icon={<Puzzle />}
            onClick={() => useModStore.getState().openPanel(mod.manifest.id)}
          >
            {mod.manifest.name}
          </Button>
          <ModControls id={mod.manifest.id} blocks={mod.views.compact} />
        </div>
      ))}
    </section>
  );
}

// This is a separate app panel so opening a mod keeps the mail view intact.
export function ModPanel() {
  const id = useModStore((s) => s.panel);
  const mod = useModStore((s) => s.mods.find((m) => m.manifest.id === id && m.running));
  if (!mod) return null;
  return (
    <PanelBody
      key={mod.manifest.id}
      id={mod.manifest.id}
      name={mod.manifest.name}
      blocks={mod.views.panel}
    />
  );
}

function PanelBody({
  id,
  name,
  blocks,
}: {
  id: string;
  name: string;
  blocks: Parameters<typeof ModControls>[0]["blocks"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="mod-panel"
      role="region"
      aria-label={`${name} panel`}
      data-owns-keys
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          useModStore.getState().openPanel(null);
        }
      }}
    >
      <div className="mod-panel-header">
        <h2>{name}</h2>
        <IconButton
          label="Close mod panel"
          icon={<X />}
          onClick={() => useModStore.getState().openPanel(null)}
        />
      </div>
      <div className="mod-panel-content">
        <ModControls id={id} blocks={blocks} />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => useSettingsStore.getState().openSettings(`mod:${id}`)}
        >
          Settings
        </Button>
      </div>
    </div>
  );
}
