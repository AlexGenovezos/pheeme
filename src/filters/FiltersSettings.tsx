// Settings › Filters: every Gmail filter on each account, in words (what it matches, what it does),
// with Edit and Delete, and Create filter. Read from Gmail when the page opens; filters aren't
// synced. Sender rules (Settings › Inbox) are filters too, so they're listed here as well.
import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { toast, toastError } from "../components/ui/Toast";
import {
  createFilter,
  deleteFilter,
  type FilterEntry,
  listFilters,
  toCommandError,
} from "../lib/tauri";
import { ReconnectButton } from "../onboarding/Reconnect";
import { accountSectionTitle, PendingButton, SettingsRow, SettingsSection } from "../settings/rows";
import { useAccountStore } from "../store/accountStore";
import { openFilterEditor } from "./editorStore";
import { sentence } from "./form";
import "./filters.css";

type List =
  | { kind: "loading" }
  | { kind: "ready"; filters: FilterEntry[] }
  | { kind: "no-access" }
  | { kind: "failed"; message: string };

function useFilterList(accountId: string) {
  const [list, setList] = useState<List>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let live = true;
    listFilters(accountId)
      .then((filters) => ({ kind: "ready", filters }) as const)
      .catch((raw: unknown): List => {
        const e = toCommandError(raw);
        return e.code === "missing_scope"
          ? { kind: "no-access" }
          : { kind: "failed", message: e.message };
      })
      .then((next) => live && setList(next));
    return () => {
      live = false;
    };
  }, [accountId, reloads]);
  const change = (edit: (filters: FilterEntry[]) => FilterEntry[]) =>
    setList((l) => (l.kind === "ready" ? { kind: "ready", filters: edit(l.filters) } : l));
  return { list, change, reload: () => setReloads((n) => n + 1) };
}

function AccountFilters({ accountId, title }: { accountId: string; title: string }) {
  const { list, change, reload } = useFilterList(accountId);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set());

  const saved = (entry: FilterEntry, replaced?: string) =>
    change((filters) =>
      replaced && filters.some((f) => f.id === replaced)
        ? filters.map((f) => (f.id === replaced ? entry : f))
        : [...filters.filter((f) => f.id !== entry.id), entry],
    );

  const remove = async (filter: FilterEntry) => {
    setDeleting((d) => new Set(d).add(filter.id));
    try {
      await deleteFilter(accountId, filter.id);
      change((filters) => filters.filter((f) => f.id !== filter.id));
      const spec = filter.spec;
      toast({
        title: "Filter deleted",
        action: spec
          ? {
              label: "Undo",
              run: () =>
                void createFilter(accountId, spec, false).then((s) => saved(s.filter), toastError),
            }
          : undefined,
      });
    } catch (raw) {
      toastError(raw);
    } finally {
      setDeleting((d) => {
        const next = new Set(d);
        next.delete(filter.id);
        return next;
      });
    }
  };

  const create = (
    <Button
      size="sm"
      disabled={list.kind !== "ready"}
      onClick={() => openFilterEditor({ accountId, onSaved: saved })}
    >
      Create filter
    </Button>
  );

  return (
    <SettingsSection title={title} action={create}>
      {list.kind === "loading" && (
        // One row shaped like a filter's, so the first filter arrives in its place.
        <SettingsRow
          title={<Skeleton width="16em" />}
          description={<Skeleton width="11em" />}
          control={<PendingButton />}
        />
      )}
      {list.kind === "no-access" && (
        <SettingsRow
          title="Pheeme can't see this account's Gmail filters"
          description="Sign in again and allow Pheeme to manage your Gmail filters."
          control={<ReconnectButton accountId={accountId} />}
        />
      )}
      {list.kind === "failed" && (
        <SettingsRow
          title="Couldn't load filters"
          description={list.message}
          control={
            <Button size="sm" onClick={reload}>
              Try again
            </Button>
          }
        />
      )}
      {list.kind === "ready" && list.filters.length === 0 && (
        <SettingsRow
          title="No filters"
          description="Create one here, or choose Filter messages like these on a conversation."
        />
      )}
      {list.kind === "ready" &&
        list.filters.map((filter) => {
          const spec = filter.spec;
          return (
            <SettingsRow
              key={filter.id}
              className="filter-row"
              title={filter.matches || "Matches every message"}
              description={sentence(filter.actions)}
              control={
                <>
                  <Button
                    size="sm"
                    disabled={!spec || deleting.has(filter.id)}
                    title={
                      spec
                        ? undefined
                        : "This filter does more than the form can show. Change it in Gmail."
                    }
                    aria-label={`Edit the filter ${filter.matches}`}
                    onClick={() =>
                      spec &&
                      openFilterEditor({ accountId, filterId: filter.id, spec, onSaved: saved })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={deleting.has(filter.id)}
                    aria-label={`Delete the filter ${filter.matches}`}
                    onClick={() => void remove(filter)}
                  >
                    Delete
                  </Button>
                </>
              }
            />
          );
        })}
    </SettingsSection>
  );
}

export function FiltersSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  if (accounts.length === 0)
    return (
      <SettingsSection title="Filters">
        <SettingsRow title="No accounts" description="Connect an account to see its filters." />
      </SettingsSection>
    );
  return (
    <>
      {accounts.map((a) => (
        <AccountFilters
          key={a.id}
          accountId={a.id}
          title={accountSectionTitle("Filters", a.email, accounts.length)}
        />
      ))}
    </>
  );
}
