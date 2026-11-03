import { beforeEach, expect, test } from "vitest";
import { parseClientJson } from "./clientJson";
import { clearProgress, loadProgress, saveProgress } from "./progress";
import { STEPS } from "./steps";
import { BROWSER_PROBLEMS, problemTitle } from "./troubleshooting";

beforeEach(() => localStorage.clear());

test("progress defaults to welcome and ignores junk", () => {
  expect(loadProgress()).toEqual({ step: "welcome", clientId: "" });
  localStorage.setItem("pheeme.onboarding.v1", "{not json");
  expect(loadProgress().step).toBe("welcome");
  localStorage.setItem("pheeme.onboarding.v1", JSON.stringify({ step: "nope" }));
  expect(loadProgress().step).toBe("welcome");
  saveProgress({ step: "consent", clientId: "x" });
  expect(loadProgress()).toEqual({ step: "consent", clientId: "x" });
  clearProgress();
  expect(loadProgress().step).toBe("welcome");
});

test("every console link is https on a host the backend allows", () => {
  const urls = [
    ...STEPS.flatMap((step) => (step.link ? [step.link.url] : [])),
    ...BROWSER_PROBLEMS.flatMap((problem) => (problem.link ? [problem.link.url] : [])),
  ];
  expect(urls.length).toBeGreaterThan(5);
  for (const url of urls) expect(new URL(url).origin).toBe("https://console.cloud.google.com");
});

test("the guide covers the steps the design requires, in order", () => {
  expect(STEPS.map((s) => s.id)).toEqual([
    "welcome",
    "project",
    "gmail-api",
    "calendar-api",
    "consent",
    "branding",
    "publish",
    "client",
    "credentials",
    "unverified",
    "authorize",
  ]);
  expect(STEPS.find((s) => s.id === "publish")?.why).toContain("7 days");
});

test("client JSON parsing", () => {
  expect(parseClientJson("abc.apps.googleusercontent.com")).toBeNull();
  expect(parseClientJson("{broken")).toBeNull();
  expect(parseClientJson('{"installed":{"client_id":"i","client_secret":"s"}}')).toEqual({
    ok: true,
    clientId: "i",
    clientSecret: "s",
  });
  expect(parseClientJson('{"web":{}}')).toMatchObject({ ok: false });
  expect(parseClientJson('{"other":1}')).toMatchObject({ ok: false });
});

test("unknown error codes get a generic title", () => {
  expect(problemTitle("invalid_grant")).toBe("Signed out by Google");
  expect(problemTitle("weird")).toBe("Sign-in didn't finish");
});
