import { Button } from "../../components/ui/Button";

export function Footer({
  onBack,
  primary,
}: {
  onBack?: () => void;
  primary: { label: string; onClick: () => void; disabled?: boolean; submit?: boolean };
}) {
  return (
    <div className="onboarding-footer">
      {onBack ? (
        <Button variant="ghost" size="lg" onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button
        type={primary.submit ? "submit" : "button"}
        variant="primary"
        size="lg"
        disabled={primary.disabled}
        onClick={primary.submit ? undefined : primary.onClick}
      >
        {primary.label}
      </Button>
    </div>
  );
}
