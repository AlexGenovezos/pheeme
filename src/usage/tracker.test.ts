import { describe, expect, it } from "vitest";
import { createUsageTracker, IDLE_MS } from "./tracker";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("usage tracker", () => {
  it("counts opens and time on screen", () => {
    const c = clock();
    const tracker = createUsageTracker(c.now);
    tracker.setScreens(["mail.inbox"]);
    c.advance(1000);
    tracker.input();
    tracker.setScreens(["mail.inbox", "mail.conversation"]);
    c.advance(500);
    tracker.setScreens(["calendar.week"]);
    tracker.setScreens(["mail.inbox"]);

    expect(tracker.take().screens).toEqual([
      { name: "mail.inbox", opens: 2, ms: 1500 },
      { name: "mail.conversation", opens: 1, ms: 500 },
      { name: "calendar.week", opens: 1, ms: 0 },
    ]);
    expect(tracker.take()).toEqual({ screens: [], commands: [] });
  });

  it("stops counting time while unfocused and after the user goes idle", () => {
    const c = clock();
    const tracker = createUsageTracker(c.now);
    tracker.setScreens(["calendar.month"]);
    c.advance(1000);
    tracker.setAttentive(false);
    c.advance(60_000);
    tracker.setAttentive(true);
    c.advance(IDLE_MS + 60_000); // walked away
    tracker.input();
    c.advance(2000);

    const [month] = tracker.take().screens;
    expect(month).toEqual({ name: "calendar.month", opens: 1, ms: 1000 + IDLE_MS + 2000 });
  });

  it("counts commands by how they ran, never a mod's or a template's own ids", () => {
    const tracker = createUsageTracker(() => 0);
    tracker.command("go.inbox", "key");
    tracker.command("go.inbox", "key");
    tracker.command("go.inbox", "palette");
    tracker.command("mod:weather:refresh", "key");
    tracker.command("calendar.template:0b7c4f1e-2a", "palette");
    tracker.command("label with spaces", "button");

    expect(tracker.take().commands).toEqual([
      { id: "go.inbox", source: "key", count: 2 },
      { id: "go.inbox", source: "palette", count: 1 },
      { id: "mod", source: "key", count: 1 },
      { id: "calendar.template", source: "palette", count: 1 },
    ]);
  });

  it("ignores screen names that aren't the app's own", () => {
    const tracker = createUsageTracker(() => 0);
    tracker.setScreens(["settings.mod", "Label: Taxes"]);
    expect(tracker.take().screens.map((s) => s.name)).toEqual(["settings.mod"]);
  });
});
