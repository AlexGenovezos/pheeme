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
  speedRead: {
    title: "Long emails, read in a flash.",
    text: "The speed reader shows one word at a time, so your eyes never move.",
  },
  reader: "<b>Space</b> starts reading",
  faster: "<b>↑</b> reads faster",
  calendar: {
    title: "Your calendar, built in.",
    text: "Google Calendar, wired into your mail. Not another tab.",
  },
  invite: "Invites show your day, clashes and all. Answer in the email.",
  switch: "One click, or <b>⌘2</b>, and your calendar is there",
  views: "Day, week or month, for every account",
  quickAdd: "Type plans the way you'd say them",
  fromEmail: "Turn any email into an event",
  filled: "The time and the people come from the email",
  pinned: "The email stays pinned beside your calendar",
  settings: {
    title: "Know your inbox. Bring your AI.",
    text: "Mail stats show what fills your inbox, and a built-in MCP server lets assistants help, on your terms.",
  },
  stats: "Mail stats: how much arrives, and how much you open",
  senders: "Who sends the most, with one-click unsubscribe",
  mcp: "A built-in MCP server, on your computer only",
  permissions: "You choose what assistants may change",
  connect: "Connect Claude Code with one command",
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

/**
 * The parts of the video, in order. `npm run video:site -- --scene settings` films only those
 * named (the rest still play, unfilmed, so the app is in the right state) for a quick look.
 */
export const SCENES = ["title", "keyboard", "search", "tabs", "speed-reader", "calendar", "invite", "email-to-event", "settings", "end"];

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
  d.scene("title");
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
  d.scene("keyboard");
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

  // ---- Search ----
  d.scene("search");
  d.chapter(`${WORDS.search.title} ${WORDS.search.text}`);
  await d.headline(WORDS.search.title, WORDS.search.text);
  // The search box and the first results, beside the start of the reading pane.
  await d.focus({ x: 220, y: 0, width: 760, height: 420 }, { max: 2, ms: 900 });
  await d.press("/", { hold: 500 });
  await d.type("lisbon", { delay: 110 });
  await d.until(app.getByRole("option").filter({ hasText: "Lisbon in March" }).first(), "The search result");
  await d.wait(1600);
  // Esc leaves search, back to the inbox.
  await d.press("Escape", { hold: 600 });
  await d.shot("wide", 1000);

  // ---- Gmail's own Inbox tabs ----
  d.scene("tabs");
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

  // ---- Speed reader: a long letter, one word at a time ----
  d.scene("speed-reader");
  d.chapter(`${WORDS.speedRead.title} ${WORDS.speedRead.text}`);
  await d.headline(WORDS.speedRead.title, WORDS.speedRead.text);
  await d.click(tab("Primary"));
  await d.click(thread("Notes from the garden club"));
  // The toolbar offers it on emails that are mostly prose.
  await d.click(app.getByRole("button", { name: "Speed read", exact: true }));
  await d.hideCursor();
  const reader = app.getByRole("dialog", { name: /^Speed read:/ });
  await d.focus(reader, { max: 1.6, ms: 1000 });
  await say(WORDS.reader, 400);
  const meta = reader.locator(".speed-reader__meta");
  const before = await meta.textContent();
  await d.press("Space", { hold: 3600 });
  if ((await meta.textContent()) === before) throw new Error("Space didn't start the speed reader.");
  await say(WORDS.faster, 300);
  for (let i = 0; i < 4; i++) await d.press("ArrowUp", { hold: 450 });
  await d.wait(2600);
  await d.note();
  await d.press("Escape", { hold: 700 });
  await d.shot("wide", 1000);

  // ---- Calendar: a major part of the app, and tied into mail ----
  d.scene("calendar");
  d.chapter(`${WORDS.calendar.title} ${WORDS.calendar.text}`);
  await d.headline(WORDS.calendar.title, WORDS.calendar.text, { hold: 2600 });

  // The pointer takes you to the calendar: close on the Mail | Calendar switch in the sidebar's
  // footer, then pull back to see it.
  await d.focus({ x: 0, y: 450, width: 640, height: 360 }, { max: 2.2, ms: 1000 });
  await say(WORDS.switch, 300);
  const toCalendar = app.locator(".mode-switch").getByRole("radio", { name: "Calendar", exact: true });
  await d.click(toCalendar, { glide: 1000, settle: 300 });
  await d.until(app.locator(".cal-toolbar"), "Calendar mode");
  await d.wait(900);
  await d.hideCursor();
  await d.shot("wide", 1100);
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

  // Back in Mail, the calendar is in your email too.
  d.scene("invite");
  await d.press("Meta+1", { hold: 700 });
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
  await d.shot("wide", 900);

  // Any email, made into an event: the time and guests read from it, the email pinned beside it.
  d.scene("email-to-event");
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

  // ---- Settings: mail stats, then the built-in MCP server ----
  d.scene("settings");
  d.chapter(`${WORDS.settings.title} ${WORDS.settings.text}`);
  await d.headline(WORDS.settings.title, WORDS.settings.text);
  // Mail stats: its own window, from the sidebar's footer.
  const footer = app.locator(".sidebar__footer:visible");
  await d.click(footer.getByRole("button", { name: "Mail stats" }));
  const stats = app.getByRole("dialog", { name: "Stats" });
  const tiles = stats.locator(".stats__tiles");
  await d.until(tiles.getByText(/\d/).first(), "Mail stats");
  await d.hideCursor();
  // With the view tabs at the top right in the shot.
  const views = stats.getByRole("radiogroup", { name: "View" });
  await d.focus([tiles, stats.getByRole("region", { name: "Received over time" }), views], { max: 1.8, ms: 1000 });
  await say(WORDS.stats, 2400);
  await d.shot("wide", 700);
  await d.click(stats.getByRole("radio", { name: "Senders" }));
  const senders = stats.getByRole("region", { name: "Top senders" });
  await d.until(senders, "Top senders");
  await d.hideCursor();
  await d.focus([senders, views], { max: 1.8, ms: 1000 });
  await say(WORDS.senders, 2400);
  await d.note();
  await d.shot("wide", 900);
  await d.press("Escape", { hold: 600 });

  // MCP, in Settings.
  await d.click(footer.getByRole("button", { name: "Settings" }));
  const settings = app.getByRole("dialog", { name: /^Settings/ });
  const page = (name) =>
    settings.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name, exact: true });
  /** Settings pages scroll: bring a part of one to the middle before the camera goes there. */
  const reveal = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await d.click(page("MCP"));
  const allow = settings.getByRole("switch", { name: "Allow MCP connections" });
  const server = settings.getByRole("region", { name: "MCP server" });
  await reveal(server);
  await d.focus(server, { max: 1.8, margin: 40, ms: 900 });
  await say(WORDS.mcp, 300);
  await d.click(allow);
  if ((await allow.getAttribute("aria-checked")) !== "true") throw new Error("MCP didn't turn on.");
  await d.wait(1400);
  const permissions = settings.getByRole("region", { name: "What clients may change" });
  await d.shot("wide", 700);
  await reveal(permissions);
  await d.focus(permissions, { max: 1.8, ms: 900 });
  await say(WORDS.permissions, 300);
  await d.click(permissions.getByRole("switch", { name: "Write drafts" }));
  await d.wait(1200);
  await d.shot("wide", 700);
  const clients = settings.getByRole("region", { name: "Connected clients" });
  await reveal(clients);
  await d.focus(clients, { max: 1.8, margin: 60, ms: 900 });
  await say(WORDS.connect, 300);
  // The name is already filled in as Claude Code.
  await d.click(clients.getByRole("button", { name: "Connect", exact: true }));
  await d.hideCursor();
  const command = settings.getByLabel("Claude Code command");
  await d.until(command, "The Claude Code command");
  await reveal(command);
  await d.focus(command, { max: 1.8, margin: 80, ms: 900 });
  await d.wait(2400);
  await d.note();
  await d.shot("wide", 900);
  await d.press("Escape", { hold: 600 });

  // ---- End card ----
  d.scene("end");
  d.chapter(`${WORDS.end.title} ${WORDS.end.text} ${WORDS.end.cta}`);
  await d.stage("blur", true);
  await d.shot("back", 900);
  await d.card(WORDS.end, { hold: 4200 });
}
