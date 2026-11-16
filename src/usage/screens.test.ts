import { describe, expect, it } from "vitest";
import { currentScreens, mailboxScreen, settingsScreen, type ScreenState } from "./screens";

const base: ScreenState = {
  mode: "mail",
  view: "week",
  mailbox: { accountId: "a", labelId: "INBOX" },
  searchText: "",
  conversationOpen: false,
  eventOpen: false,
  eventEditorOpen: false,
  emailPinned: false,
  settingsPage: null,
  statsOpen: false,
  paletteOpen: false,
  composing: false,
  previewOpen: false,
  personOpen: false,
  speedReading: false,
  tasksOpen: false,
  themeEditorOpen: false,
};

describe("screens", () => {
  it("names mailboxes without user labels' names", () => {
    expect(mailboxScreen({ accountId: null, labelId: "INBOX" }, "")).toBe("mail.inbox");
    expect(
      mailboxScreen({ accountId: "a", labelId: "INBOX", category: "CATEGORY_SOCIAL" }, ""),
    ).toBe("mail.inbox");
    expect(mailboxScreen({ accountId: "a", labelId: "DRAFT" }, "")).toBe("mail.drafts");
    expect(mailboxScreen({ accountId: "a", labelId: "Label_12" }, "")).toBe("mail.label");
    expect(mailboxScreen({ accountId: "a", labelId: "Label_12" }, " from:sam ")).toBe(
      "mail.search",
    );
  });

  it("names a mod's settings page settings.mod", () => {
    expect(settingsScreen("about")).toBe("settings.about");
    expect(settingsScreen("mod:com.example.weather")).toBe("settings.mod");
  });

  it("lists the mode's screen and every overlay open", () => {
    expect(currentScreens({ ...base, conversationOpen: true, composing: true })).toEqual([
      "mail.inbox",
      "mail.conversation",
      "compose",
    ]);
    expect(
      currentScreens({
        ...base,
        mode: "calendar",
        view: "month",
        conversationOpen: true,
        eventOpen: true,
        settingsPage: "keyboard",
        tasksOpen: true,
      }),
    ).toEqual(["calendar.month", "calendar.event", "settings.keyboard", "tasks"]);
  });
});
