import { displayVersion, useUpdateStore } from "../lib/updater";

export function UpdateBanner() {
  const { available, applying, apply } = useUpdateStore();
  if (!available) return null;
  return (
    <div role="status">
      <span>Pheeme {displayVersion(available)} is ready</span>
      <button type="button" disabled={applying} onClick={() => void apply()}>
        {applying ? "Updating…" : "Restart to update"}
      </button>
    </div>
  );
}
