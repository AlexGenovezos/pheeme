// The product video's storyboard. It drives the real demo app (sample mail,
// src/preview/) with the verbs in director.mjs, so when the app changes the
// next build records the new UI. Change the words or the order of features here.

/** What the video says. Also written to its description track (pheeme-tour.vtt). */
export const WORDS = {
  open: { title: "Gmail, at the speed of your keyboard." },
  meet: { title: "Meet pheeme.", text: "A desktop app for your Gmail. Free and open source." },
  speed: {
    title: "Every email opens instantly.",
    text: "Your mail is kept on your computer, so nothing waits on a server.",
  },
  tabs: {
    title: "Gmail's tabs, sorted by Gmail.",
    text: "Primary, Social, Promotions and Updates match Gmail on every device.",
  },
  calendar: {
    title: "Plans, in plain English.",
    text: "Google Calendar, one key away. Type events the way you'd say them.",
  },
  search: {
    title: "Search answers as you type.",
    text: "Mail on your computer answers first, then Gmail fills in the rest.",
  },
  end: {
    title: "Free, open source, and yours.",
    text: "Your mail goes from Google straight to your computer. No subscription, no servers in between.",
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

  // ---- Title, then the app rises over the horizon ----
  d.chapter(WORDS.open.title);
  await d.card(WORDS.open, { hold: 2600 });
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
  for (let i = 0; i < 4; i++) await d.press("j", { hold: 480 });
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
  await d.click(tab("Primary"));
  await d.wait(900);
  await d.click(tab("Promotions"));
  await d.wait(900);
  await d.click(tab("Social"));
  await d.wait(1000);
  await d.hideCursor();
  await d.shot("wide", 1000);

  // ---- Calendar, and an event typed as a sentence ----
  d.chapter(`${WORDS.calendar.title} ${WORDS.calendar.text}`);
  await d.headline(WORDS.calendar.title, WORDS.calendar.text);
  await d.press("Meta+2", { hold: 1100 });
  await d.press("c", { hold: 600 });
  const quickAdd = app.getByRole("dialog", { name: "Quick add" });
  await d.focus(quickAdd, { max: 1.9, ms: 900 });
  await d.type("Lunch with Grace Friday at noon at Joe's");
  await d.wait(1400);
  await d.press("Enter", { hold: 800 });
  const event = app.locator("main").getByText("Lunch with Grace").first();
  await d.focus(event, { max: 2, margin: 160, ms: 1200 });
  await d.wait(1400);
  await d.shot("wide", 1000);

  // ---- Search ----
  d.chapter(`${WORDS.search.title} ${WORDS.search.text}`);
  await d.press("Meta+1", { hold: 800 });
  await d.headline(WORDS.search.title, WORDS.search.text);
  // The search box and the first results, beside the start of the reading pane.
  await d.focus({ x: 220, y: 0, width: 760, height: 420 }, { max: 2, ms: 900 });
  await d.press("/", { hold: 500 });
  await d.type("lisbon", { delay: 110 });
  await d.wait(1800);

  // ---- End card ----
  d.chapter(`${WORDS.end.title} ${WORDS.end.text} ${WORDS.end.cta}`);
  await d.stage("blur", true);
  await d.shot("back", 900);
  await d.card(WORDS.end, { hold: 4200 });
}
