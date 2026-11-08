import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { useSetupGuide } from "../onboarding/guideStore";
import { AboutSettings } from "./AboutSettings";

test("Open guide asks App to open the setup guide", () => {
  const before = useSetupGuide.getState().requested;
  render(<AboutSettings />);
  expect(screen.getByText("Google Cloud setup guide")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open guide" }));
  expect(useSetupGuide.getState().requested).toBe(before + 1);
});
