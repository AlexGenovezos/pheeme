// The product video's storyboard. It drives the real demo app (sample mail,
// src/preview/) with the verbs in director.mjs, so when the app changes the
// next build records the new UI. Change the words or the order of features here.

/** What the video says. Also written to its description track (pheeme-tour.vtt). */
export const WORDS = {
  open: { title: "Gmail, at the speed of your keyboard." },
  meet: { title: "Meet pheeme.", text: "A desktop app for Gmail and Google Calendar. Free and open source." },
  speed: {
    title: "Every email opens instantly.",
    text: "Your mail is kept on your computer, so nothing waits on a server.",
  },
  tabs: {
    title: "Gmail's tabs, sorted by Gmail.",
    text: "Primary, Social, Promotions and Updates match Gmail on every device.",
  },
  calendar: {
    title: "Your calendar, built in.",
    text: "Google Calendar, wired into your mail. Not another tab.",
  },
  invite: "Invites show your day, clashes and all. Answer in the email.",
  switch: "<b>⌘2</b> and your calendar is there",
  views: "Day, week or month, for every account",
  quickAdd: "Type plans the way you'd say them",
  fromEmail: "Turn any email into an event",
  filled: "The time and the people come from the email",
  pinned: "The email stays pinned beside your calendar",
  search: {
    title: "Search answers as you type.",
    text: "Mail on your computer answers first, then Gmail fills in the rest.",
  },
  end: {
    title: "Free, open source, and yours.",
    text: "Your mail and calendar go from Google straight to your computer. No subscription, no servers in between.",
    cta: "Download free at pheeme.app",
  },
};

/** @param {import("./director.mjs").Director} d */
export default async function tour(d) {
  const app = d.$;
  const list = app.getByRole("listbox", { name: /conversations$/ });
  const sidebar = app.getByRole("complementary", { name: "Sidebar", exact: true });
  const account = app.getByRole("group", { name: "avery@example.com" });
  const tab = (name) => account.getByRole("link", { name, exact: true });
  const work = app.getByRole("group", { name: "avery@example.org" });
  const thread = (subject) => list.getByRole("option").filter({ hasText: subject }).first();
  /** A short line on screen that is also part of the description track. */
  const say = async (html, ms) => {
    d.chapter(html.replace(/<[^>]+>/g, ""));
    await d.note(html, ms);
  };

  // ---- Title, then the app rises over the horizon ----
  d.chapter(WORDS.open.title);
  // Already on screen in the first frame: the video opens on the title, not empty sky.
  await d.card(WORDS.open, { hold: 2600, now: true });
  await d.stage("fade", true);
  // The window starts rising while the card fades, so the sky is never empty.
  await d.stage("shot", "tilt", 2000);
  await d.cardOut(500);
  await d.wait(1500);
  d.chapter(`${WORDS.meet.title} ${WORDS.meet.text}`);
  await d.stage("headline", WORDS.meet.title, WORDS.meet.text, { top: true });
  await d.wait(2200);
  await d.stage("headlineOut");
  await d.stage("fade", false);
  await d.shot("wide", 1300);

  // ---- Speed: j/k through the inbox ----
  d.chapter(`${WORDS.speed.title} ${WORDS.speed.text}`);
  await d.headline(WORDS.speed.title, WORDS.speed.text);
  await d.focus({ x: 220, y: 0, width: 1220, height: 560 }, { max: 1.5, ms: 1000 });
  await d.note("<b>J</b> and <b>K</b> move through your mail", 300);
  const opened = await list.getAttribute("aria-activedescendant");
  for (let i = 0; i < 4; i++) await d.press("j", { hold: 480 });
  // A storyboard step that stops working must fail the recording, not film nothing happening.
  if ((await list.getAttribute("aria-activedescendant")) === opened) {
    throw new Error("J didn't move to another conversation.");
  }
  await d.takePoster();
  await d.press("k", { hold: 520 });
  await d.note("Done with it? <b>E</b> archives it.", 500);
  await d.press("e", { hold: 800 });
  await d.press("e", { hold: 900 });
  await d.note();
  await d.shot("wide", 1000);

  // ---- Gmail's own Inbox tabs ----
  d.chapter(`${WORDS.tabs.title} ${WORDS.tabs.text}`);
  await d.headline(WORDS.tabs.title, WORDS.tabs.text);
  await d.focus([tab("Primary"), tab("Forums")], { max: 2.4, ms: 1100 });
  await d.wait(900);
  await d.focus([sidebar.getByText("avery@example.com", { exact: true }).first(), list], {
    max: 1.6,
    ms: 1100,
  });
  // Cursor coordinates are only right once the camera stops.
  for (const name of ["Primary", "Promotions", "Social"]) {
    await d.click(tab(name));
    await d.until(app.getByRole("listbox", { name: `${name} conversations` }), `The ${name} tab`);
    await d.wait(900);
  }
  await d.hideCursor();
  await d.shot("wide", 1000);

  // ---- Calendar: a major part of the app, and tied into mail ----
  d.chapter(`${WORDS.calendar.title} ${WORDS.calendar.text}`);
  await d.headline(WORDS.calendar.title, WORDS.calendar.text, { hold: 2600 });

  // An invitation in the inbox: your day around it, the clash named, answered in place.
  await d.click(work.getByRole("link", { name: "Primary", exact: true }));
  await d.click(thread("Invitation: Design review"));
  const invite = app.getByRole("region", { name: "Invitation" });
  // Lower than usual, so the note above doesn't cover the subject.
  await d.focus(invite, { max: 1.7, dy: 80, ms: 1100 });
  await say(WORDS.invite, 1600);
  const yes = invite.getByRole("radio", { name: "Yes" });
  await d.click(yes);
  await d.wait(400);
  if ((await yes.getAttribute("aria-checked")) !== "true") throw new Error("Yes didn't answer the invitation.");
  await d.wait(1200);
  await d.hideCursor();
  await d.note();

  // One key to the calendar, in every view.
  await d.shot("wide", 900);
  await say(WORDS.switch);
  await d.press("Meta+2", { hold: 1300 });
  await say(WORDS.views);
  const view = (name) => app.locator(`.cal-toolbar[data-view="${name}"]`);
  await d.press("m", { hold: 1300 });
  await d.until(view("month"), "Month view");
  await d.press("w", { hold: 900 });
  await d.until(view("week"), "Week view");

  // Quick add: a sentence becomes the event.
  await say(WORDS.quickAdd);
  await d.press("c", { hold: 600 });
  const quickAdd = app.getByRole("dialog", { name: "Quick add" });
  await d.focus(quickAdd, { max: 1.9, ms: 900 });
  await d.type("Lunch with Grace Friday at noon at Joe's");
  await d.wait(1200);
  await d.press("Enter", { hold: 700 });
  await d.note();
  const lunch = app.locator("main").getByText("Lunch with Grace").first();
  await d.focus(lunch, { max: 2, margin: 160, ms: 1100 });
  await d.wait(1100);
  await d.shot("wide", 900);

  // Any email, made into an event: the time and guests read from it, the email pinned beside it.
  await d.press("Meta+1", { hold: 700 });
  await d.click(tab("Primary"));
  await d.click(thread("Coffee next week?"));
  await d.hideCursor();
  await say(WORDS.fromEmail);
  await d.press("Shift+E", { hold: 900, label: ["⇧", "E"] });
  const editor = app.getByRole("dialog", { name: "New event" });
  // The title, the time read from "next Thursday at 3pm" and Jonas as a guest.
  await d.focus([editor.getByRole("textbox", { name: "Title" }), editor.getByText("Jonas Weber")], {
    max: 1.9,
    margin: 30,
    ms: 1000,
  });
  await say(WORDS.filled, 2200);
  await d.shot("wide", 800);
  await d.click(editor.getByRole("button", { name: "Save" }));
  // Jonas is a guest, so Google asks whether to email the invitation.
  await d.click(app.getByRole("button", { name: "Send", exact: true }));
  await d.hideCursor();
  await say(WORDS.pinned);
  const coffee = app.locator(".cal-event__title").filter({ hasText: "Coffee next week?" }).first();
  const pinned = app.getByRole("complementary", { name: "Pinned email" });
  await d.focus([pinned.getByRole("heading", { name: "Coffee next week?" }), coffee], { max: 2, margin: 40, ms: 1100 });
  await d.wait(1800);
  await d.note();
  await d.shot("wide", 1000);

  // ---- Search ----
  d.chapter(`${WORDS.search.title} ${WORDS.search.text}`);
  await d.press("Meta+1", { hold: 800 });
  await d.headline(WORDS.search.title, WORDS.search.text);
  // The search box and the first results, beside the start of the reading pane.
  await d.focus({ x: 220, y: 0, width: 760, height: 420 }, { max: 2, ms: 900 });
  await d.press("/", { hold: 500 });
  await d.type("lisbon", { delay: 110 });
  await d.until(app.getByRole("option").filter({ hasText: "Lisbon in March" }).first(), "The search result");
  await d.wait(1600);

  // ---- End card ----
  d.chapter(`${WORDS.end.title} ${WORDS.end.text} ${WORDS.end.cta}`);
  await d.stage("blur", true);
  await d.shot("back", 900);
  await d.card(WORDS.end, { hold: 4200 });
}
