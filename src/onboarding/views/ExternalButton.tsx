import { Button } from "../../components/ui/Button";
import { openExternal } from "../../lib/tauri";
import { useFlash } from "./useFlash";

export function ExternalButton({
  label,
  url,
  primary,
}: {
  label: string;
  url: string;
  primary?: boolean;
}) {
  const [failed, flash] = useFlash();
  return (
    <Button
      variant={primary ? "primary" : "secondary"}
      size={primary ? "lg" : "sm"}
      className="external"
      onClick={() =>
        void openExternal(url).catch(() => {
          // No browser could be opened: hand the user the link instead.
          void navigator.clipboard.writeText(url).catch(() => {});
          flash();
        })
      }
    >
      {failed ? "Link copied: paste it in your browser" : `${label} ↗`}
    </Button>
  );
}
