import { type StepId, stepIndex } from "./steps";

const KEY = "pheeme.onboarding.v1";

/** Saved so a user can quit and resume. Never holds the client secret. */
export interface Progress {
  step: StepId;
  clientId: string;
}

export function loadProgress(): Progress {
  const empty: Progress = { step: "welcome", clientId: "" };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Progress> | null;
    if (!saved || typeof saved.step !== "string" || stepIndex(saved.step) === -1) return empty;
    // The secret isn't saved, so anything after the credentials form resumes there.
    const step = stepIndex(saved.step) > stepIndex("credentials") ? "credentials" : saved.step;
    return { step, clientId: typeof saved.clientId === "string" ? saved.clientId : "" };
  } catch {
    return empty;
  }
}

export function saveProgress(progress: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // Storage full or unavailable: resuming is a convenience, not a requirement.
  }
}

export function clearProgress() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
