import type { StepId } from "./steps";
import type { SignInState } from "./useSignIn";

export type View = StepId | "intro" | "choose" | "error" | "done" | "receive" | "receiving";

export type SetupView = StepId | "intro" | "choose" | "receive";

export function currentView(state: SignInState, setup: SetupView): View {
  switch (state.phase) {
    case "idle":
      return setup;
    case "receiving":
      return "receiving";
    case "authorizing":
      return "authorize";
    case "failed":
      return state.client ? "error" : "receive";
    case "connected":
      return "done";
  }
}
