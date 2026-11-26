import { type StepId, ALERTS_STEP, STEPS, isStepId, stepIndex } from "../steps";
import type { View } from "../view";

export function Rail({ current, onSelect }: { current: View; onSelect: (step: StepId) => void }) {
  const currentIndex =
    current === "error" ? stepIndex("authorize") : isStepId(current) ? stepIndex(current) : -1;
  return (
    <nav className="onboarding-rail" aria-label="Setup steps">
      <div className="onboarding-rail__brand">Pheeme</div>
      <ol>
        {STEPS.map((step, index) => {
          const state =
            current === "done" || index < currentIndex
              ? "done"
              : index === currentIndex
                ? "current"
                : "todo";
          // Only steps already reached are clickable: the guide is meant to be followed in order.
          // Not while a sign-in is waiting on the browser or finished.
          const reachable =
            state === "done" && !["authorize", "done"].includes(current) && step.id !== "authorize";
          return (
            <li key={step.id} className={`rail-step rail-step--${state}`}>
              <button
                type="button"
                disabled={!reachable}
                aria-current={state === "current" ? "step" : undefined}
                onClick={() => onSelect(step.id)}
              >
                <span className="rail-step__dot" aria-hidden>
                  {state === "done" ? "✓" : index + 1}
                </span>
                {step.short}
              </button>
            </li>
          );
        })}
        <li className={`rail-step rail-step--${current === "done" ? "current" : "todo"}`}>
          <button type="button" disabled aria-current={current === "done" ? "step" : undefined}>
            <span className="rail-step__dot" aria-hidden>
              {STEPS.length + 1}
            </span>
            {ALERTS_STEP}
          </button>
        </li>
      </ol>
    </nav>
  );
}
