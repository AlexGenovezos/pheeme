import { Search, X } from "lucide-react";
import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { IconButton } from "../components/ui/IconButton";
import { Kbd } from "../components/ui/Kbd";
import { isEditableTarget, registry } from "../keyboard/registry";
import { AddAccountContext } from "./AccountsSettings";
import { SETTINGS_PAGES } from "./pages";
import { SettingsRow, SettingsSection } from "./rows";
import { pageMatches, pageTitleMatches, settingMatches, type SettingsPageDef } from "./schema";
import { useSettingsStore } from "./settingsStore";
import "./Settings.css";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The settings dialog over the blurred app. Mount once, inside the mail screen. */
export function Settings({
  pages = SETTINGS_PAGES,
  onAddAccount,
}: {
  pages?: SettingsPageDef[];
  onAddAccount?: () => void;
}) {
  const open = useSettingsStore((s) => s.open);
  if (!open) return null;
  return (
    <AddAccountContext.Provider value={onAddAccount}>
      <SettingsDialog pages={pages} />
    </AddAccountContext.Provider>
  );
}

function SettingsDialog({ pages }: { pages: SettingsPageDef[] }) {
  const pageId = useSettingsStore((s) => s.page);
  const setPage = useSettingsStore((s) => s.setPage);
  const close = useSettingsStore((s) => s.close);
  const [query, setQuery] = useState("");
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = pages.filter((p) => pageMatches(p, query));
  const page = visible.find((p) => p.id === pageId) ?? visible[0];

  // While the dialog is open, keys belong to it: mail shortcuts would act on the app behind.
  useEffect(() => registry.suspend(), []);

  useEffect(() => {
    dialogRef.current?.focus();
    return () => returnFocus?.focus?.();
  }, [returnFocus]);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "/" && !isEditableTarget(e.target)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // Keep Tab inside the dialog.
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    } else if (e.key === "Enter" && page) {
      e.preventDefault();
      setPage(page.id);
    }
  };

  const groups = [...new Set(visible.map((p) => p.group))];

  return (
    <div className="settings-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <div className="settings__nav">
          <label className="settings__search">
            <Search aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search settings"
              placeholder="Search"
              spellCheck={false}
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            {!query && <Kbd shortcut="/" />}
          </label>
          <nav aria-label="Settings sections" className="settings__pages">
            {groups.map((group) => (
              <Fragment key={group ?? ""}>
                {group && <div className="settings__group">{group}</div>}
                {visible
                  .filter((p) => p.group === group)
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="settings__page"
                      aria-current={p.id === page?.id ? "page" : undefined}
                      onClick={() => setPage(p.id)}
                    >
                      <p.icon aria-hidden="true" />
                      {p.title}
                    </button>
                  ))}
              </Fragment>
            ))}
            {visible.length === 0 && <p className="settings-empty">No matches</p>}
          </nav>
        </div>

        <div className="settings__main">
          <header className="settings__header">
            <h2 id="settings-title" className="settings__crumbs">
              <span>Settings</span>
              {page && (
                <>
                  <span aria-hidden="true">/</span>
                  <span className="settings__crumb-current">{page.title}</span>
                </>
              )}
            </h2>
            <div className="settings__header-actions">
              {page?.HeaderAction && <page.HeaderAction />}
              <IconButton label="Close settings" icon={<X />} onClick={close} />
            </div>
          </header>
          <div className="settings__body">
            <div className="settings__content">
              {!page && <p className="settings-empty">No settings match “{query.trim()}”</p>}
              {page && <PageBody page={page} query={query} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PageBody({ page, query }: { page: SettingsPageDef; query: string }) {
  if (page.Component) return <page.Component query={query} />;
  // A search that names the page shows all of it; otherwise only the rows it finds.
  const all = !query.trim() || pageTitleMatches(page, query);
  return (
    <>
      {(page.sections ?? []).map((section) => {
        const settings = all
          ? section.settings
          : section.settings.filter((s) => settingMatches(s, query));
        if (!settings.length) return null;
        return (
          <SettingsSection key={section.title} title={section.title}>
            {settings.map((s) => (
              <SettingsRow
                key={s.id}
                title={s.title}
                description={s.description}
                control={<s.Control />}
              />
            ))}
          </SettingsSection>
        );
      })}
    </>
  );
}
