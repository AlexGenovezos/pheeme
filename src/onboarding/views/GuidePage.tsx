import { Button } from "../../components/ui/Button";
import type { GuideStep } from "../steps";
import { ExternalButton } from "./ExternalButton";
import { Footer } from "./Footer";
import { useFlash } from "./useFlash";

export function GuidePage({
  step,
  primary,
  onBack,
}: {
  step: GuideStep;
  primary: { label: string; onClick: () => void };
  onBack?: () => void;
}) {
  const numbered = step.id !== "unverified";
  return (
    <>
      <h1>{step.title}</h1>
      {numbered ? (
        <ol className="guide-actions">
          {step.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
      ) : (
        step.actions.map((action) => (
          <p key={action} className="guide-lead">
            {action}
          </p>
        ))
      )}
      {step.link && <ExternalButton label={step.link.label} url={step.link.url} primary />}
      {step.copy && (
        <div className="copy-list">
          {step.copy.map((item) => (
            <CopyField key={item.label} {...item} />
          ))}
        </div>
      )}
      {step.screenshot && <img className="guide-shot" src={step.screenshot} alt="" />}
      {step.why && (
        <p className="guide-why">
          <strong>Why: </strong>
          {step.why}
        </p>
      )}
      <Footer onBack={onBack} primary={primary} />
    </>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, flash] = useFlash();
  return (
    <div className="copy-field">
      <span className="copy-field__label">{label}</span>
      <code className="copy-field__value">{value}</code>
      <Button
        size="sm"
        onClick={() => void navigator.clipboard.writeText(value).then(flash, () => {})}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
