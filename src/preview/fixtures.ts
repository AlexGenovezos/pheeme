/**
 * Fixture mail for browser preview mode. Shapes follow what the Rust commands return (see `lib/tauri.ts`),
 * so the real mail UI runs against them unchanged.
 *
 * Two accounts, each with inbox threads in every category (some unread), starred and draft threads,
 * user labels with and without colors, a 4-message and a 12-message thread, plain-text bodies with URLs,
 * HTML bodies (remote image, dark-mode declaring) and PDF attachments.
 *
 * `createFixtureThreads()` builds a fresh, mutable copy: the preview handlers own one per session, so
 * archive, star and trash in the browser change what the lists and counts show.
 */
import type { AttachmentInfo, EmailAddress } from "../lib/tauri";

export interface FixtureAccount {
  id: string;
  email: string;
  displayName: string;
}

export interface FixtureUserLabel {
  id: string;
  accountId: string;
  name: string;
  /** Gmail's label color, shown as a dot in the sidebar; none means uncolored. */
  color?: string;
  /** Gmail's `labelShow` (the default) | `labelShowIfUnread` | `labelHide`. */
  labelListVisibility?: string;
}

export interface FixtureMessage {
  id: string;
  fromName: string;
  fromAddress: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  date: number;
  unread: boolean;
  bodyText: string | null;
  /** Trusted fixture HTML: the preview does not sanitize it (the backend's `render.rs` does in the app). */
  bodyHtml: string | null;
  hasRemoteContent: boolean;
  declaresDarkMode: boolean;
  attachments: AttachmentInfo[];
}

export interface FixtureThread {
  id: string;
  accountId: string;
  /** Gmail label ids except UNREAD, which follows the messages. Includes STARRED and `CATEGORY_*`. */
  labelIds: string[];
  subject: string;
  messages: FixtureMessage[];
}

const NOW = Date.now();
const minutesAgo = (m: number) => NOW - m * 60_000;
const hoursAgo = (h: number) => minutesAgo(h * 60);
const daysAgo = (d: number) => hoursAgo(d * 24);

export const fixtureAccounts: FixtureAccount[] = [
  { id: "acc-personal", email: "avery@example.com", displayName: "Avery Quinn" },
  { id: "acc-work", email: "avery@example.org", displayName: "Avery (Studio)" },
];

export const fixtureUserLabels: FixtureUserLabel[] = [
  { id: "Label_1", accountId: "acc-personal", name: "Receipts" },
  { id: "Label_2", accountId: "acc-personal", name: "Travel", color: "#16a766" },
  { id: "Label_3", accountId: "acc-personal", name: "Pheeme", color: "#4a86e8" },
  // A sublabel, and a hidden parent whose sublabel goes under More with it.
  { id: "Label_4", accountId: "acc-personal", name: "Travel/Lisbon" },
  { id: "Label_5", accountId: "acc-personal", name: "Archive", labelListVisibility: "labelHide" },
  { id: "Label_6", accountId: "acc-personal", name: "Archive/Old projects" },
  { id: "Label_10", accountId: "acc-work", name: "Customers", color: "#ffad47" },
  { id: "Label_11", accountId: "acc-work", name: "Invoices" },
];

/** The system labels `list_labels` returns for every account. */
export const SYSTEM_LABELS: { id: string; name: string }[] = [
  { id: "INBOX", name: "Inbox" },
  { id: "STARRED", name: "Starred" },
  { id: "SENT", name: "Sent" },
  { id: "DRAFT", name: "Drafts" },
  { id: "SPAM", name: "Spam" },
  { id: "TRASH", name: "Trash" },
  { id: "CATEGORY_SOCIAL", name: "Social" },
  { id: "CATEGORY_PROMOTIONS", name: "Promotions" },
  { id: "CATEGORY_UPDATES", name: "Updates" },
  { id: "CATEGORY_FORUMS", name: "Forums" },
];

export const CATEGORY_IDS = [
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];
const OTHER_CATEGORY_IDS = CATEGORY_IDS.filter((id) => id !== "CATEGORY_PERSONAL");

/** The tabs an account hides, for Primary to take their mail. */
export type HiddenTabs = (accountId: string) => readonly string[];

// ── Rich bodies ──────────────────────────────────────────────────────────────

/**
 * A logo as a `data:` image. In the app an inline image is a `cid:` reference served by the `pheeme-att`
 * protocol; a browser can't resolve that, so the preview uses a `data:` image for the inline case.
 */
const LOGO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#4a86e8"/><path d="M12 16h24v16H12z" fill="none" stroke="#fff" stroke-width="3"/><path d="m12 17 12 9 12-9" fill="none" stroke="#fff" stroke-width="3"/></svg>',
)}`;

/** Remote image: blocked by the frame's CSP until "Load images". */
const REMOTE_IMAGE = "https://picsum.photos/seed/pheeme/520/160";

const CI_HTML = `
<div style="font-family: Arial, sans-serif; max-width: 560px; color: #24292f;">
  <table role="presentation" style="border-collapse: collapse;"><tr>
    <td style="padding-right: 12px;"><img src="${LOGO}" width="40" height="40" alt="Pheeme"></td>
    <td><strong style="font-size: 16px;">All checks have passed</strong><br><span style="color: #57606a;">feat/mail-ui at 1b3dbfc</span></td>
  </tr></table>
  <ul>
    <li>typecheck</li><li>lint</li><li>test</li><li>macOS bundle</li>
  </ul>
  <p><img src="${REMOTE_IMAGE}" alt="Build timeline" style="width: 100%; border-radius: 6px;"></p>
  <p><a href="https://ci.example.com/runs/1031">View the run on GitHub</a> or
  <a href="mailto:avery@example.org">reply to the author</a>.</p>
</div>`;

const DARK_NEWSLETTER_HTML = `
<style>
  :root { color-scheme: light dark; }
  body { background: #fff; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #16181d; color: #e8e8ea; } a { color: #8ab4f8; } }
</style>
<div style="font-family: Georgia, serif; max-width: 520px; padding: 16px;">
  <h2 style="margin: 0 0 8px;">The Tessellate Review</h2>
  <p>Seven small interfaces worth stealing from this month, from a calmer inbox to a command palette that
  finally knows what you meant.</p>
  <p><a href="https://example.com/review/issue-31">Read the issue</a></p>
</div>`;

const PROMO_HTML = `
<div style="font-family: Arial, sans-serif; max-width: 520px; text-align: center; background: #fff7e6; color: #3b2a00; padding: 24px;">
  <h1 style="margin: 0 0 8px;">Spring upgrade, 30% off</h1>
  <p>Move your team to the annual plan before Friday.</p>
  <p><a href="https://example.com/upgrade" style="background: #d97706; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Upgrade now</a></p>
  <p style="font-size: 12px; color: #7a6a4a;">You are receiving this because you signed up for product updates.</p>
</div>`;

const SECURITY_HTML = `
<div style="font-family: Arial, sans-serif; max-width: 520px; color: #202124;">
  <h2 style="margin: 0 0 8px;">New sign-in on a Mac</h2>
  <p>Your account <strong>avery@example.org</strong> was just signed in to from a new device.</p>
  <table style="border-collapse: collapse;"><tr><td style="padding: 2px 12px 2px 0; color: #5f6368;">Where</td><td>Lisbon, Portugal</td></tr>
  <tr><td style="padding: 2px 12px 2px 0; color: #5f6368;">Device</td><td>MacBook Pro</td></tr></table>
  <p><a href="https://example.com/security">Check activity</a></p>
</div>`;

const GARDEN_LETTER = `<div>
<p>Avery, I promised to write up what we talked about on Saturday, so here it is while it is still fresh.</p>
<p>The tomatoes along the south fence did better than anyone expected. We think the difference was the mulch. Last year we left the soil bare, it dried out by noon, and the plants spent the whole summer sulking. This year Tom spread straw two inches deep in May, and we watered half as often.</p>
<p>The beans were another story. Something ate the first planting down to the stems in a single night, and the second planting came up thin. Rabbits, probably, though Margaret still blames the neighbour's chickens. Next spring we will put up the low wire fence before anything goes in the ground.</p>
<p>A few of us would like to try a winter crop this year. Garlic goes in around the middle of October and sits quietly until spring, so it would not need much looking after. If you have room in the shed for two bags of compost, that would save us a trip.</p>
<p>The next meeting is the first Sunday of the month at ten. Bring a chair, and bring your seed catalogues if you still have them. We will sort out who is growing what before anyone orders.</p>
<p>Thank you again for lending the hose. It has never worked so well.</p>
<p>Harriet</p>
</div>`;

const file = (id: string, filename: string, mimeType: string, size: number): AttachmentInfo => ({
  id,
  filename,
  mimeType,
  size,
  isInline: false,
  contentId: null,
});
/** An invitation's two calendar files, as Google sends them: the `text/calendar` part beside the body and `invite.ics`. */
const invite = (id: string): AttachmentInfo[] => [
  {
    id: `${id}-cal`,
    filename: null,
    mimeType: "text/calendar",
    size: 1_834,
    isInline: false,
    contentId: null,
  },
  {
    id: `${id}-ics`,
    filename: "invite.ics",
    mimeType: "application/ics",
    size: 1_834,
    isInline: false,
    contentId: null,
  },
];

const pdf = (id: string, filename: string, size: number) =>
  file(id, filename, "application/pdf", size);

// ── Builders ─────────────────────────────────────────────────────────────────

type Person = [name: string, address: string];

const ME: Record<string, Person> = {
  "acc-personal": ["Avery Quinn", "avery@example.com"],
  "acc-work": ["Avery (Studio)", "avery@example.org"],
};

interface MessageOptions {
  unread?: boolean;
  html?: string;
  remote?: boolean;
  dark?: boolean;
  attachments?: AttachmentInfo[];
}

const addr = ([name, address]: Person): EmailAddress => ({ name, address });

function message(
  id: string,
  from: Person,
  date: number,
  text: string,
  to: Person,
  o: MessageOptions = {},
): FixtureMessage {
  return {
    id,
    fromName: from[0],
    fromAddress: from[1],
    to: [addr(to)],
    cc: [],
    date,
    unread: o.unread ?? false,
    bodyText: text,
    bodyHtml: o.html ?? null,
    hasRemoteContent: o.remote ?? false,
    declaresDarkMode: o.dark ?? false,
    attachments: o.attachments ?? [],
  };
}

const thread = (
  id: string,
  accountId: string,
  labelIds: string[],
  subject: string,
  messages: FixtureMessage[],
): FixtureThread => ({
  id,
  accountId,
  labelIds,
  subject,
  messages,
});

/** A fresh copy of every fixture thread. */
export function createFixtureThreads(): FixtureThread[] {
  const P = "acc-personal";
  const W = "acc-work";
  const me = ME[P];
  const work = ME[W];
  const mira: Person = ["Mira Okafor", "mira@example.net"];
  const jonas: Person = ["Jonas Weber", "jonas@example.net"];
  const dana: Person = ["Dana Whitfield", "dana@lumen.example"];

  // The long thread: twelve messages, the last one unread.
  const lisbon = Array.from({ length: 12 }, (_, i) => {
    const mine = i % 2 === 1;
    const lines = [
      "Flights are cheap the week of the 9th. I can book the flat near Príncipe Real if you confirm by Sunday.",
      "Sunday works. Is the flat on a steep street? My knee has opinions.",
      "Flat is on the flat part, ha. Lift in the building too.",
      "Then yes. Which flights did you find?",
      "TAP at 07:10 or the Ryanair one at noon. TAP is 40 euros more.",
      "TAP. I would rather lose a morning than a day.",
      "Booked. Sending the confirmation next.",
      "Got it. Should we do the Sintra day trip on the Tuesday?",
      "Tuesday is the only dry day in the forecast, so yes.",
      "Great. I will bring the good camera.",
      "Also: dinner on the first night is on me. Ana knows a place.",
      "Perfect. Here is the map link: https://maps.example.com/lisbon-dinner. See you at the airport!",
    ];
    return message(
      `p-03-m${i + 1}`,
      mine ? me : jonas,
      i === 11 ? minutesAgo(130) : daysAgo(6) + i * 40 * 60_000,
      lines[i],
      mine ? jonas : me,
      { unread: i === 11 },
    );
  });

  return [
    // ── Personal: inbox, one or more threads per category ──
    thread("p-01", P, ["INBOX", "Label_3"], "Icon sketches for the dock", [
      message(
        "p-01-m1",
        mira,
        daysAgo(2),
        "Hi Avery,\n\nFirst pass at the dock icon. Do you want it playful or plain?",
        me,
      ),
      message(
        "p-01-m2",
        me,
        daysAgo(2) + 600_000,
        "Plain, with a little warmth. Can you try a folded letter?",
        mira,
      ),
      message(
        "p-01-m3",
        mira,
        hoursAgo(5),
        "Three directions attached. The folded-letter one reads best at 16 px; the trumpet is fun but gets busy below 32 px.",
        me,
        { attachments: [pdf("p-01-a1", "dock-icon-directions.pdf", 482_113)] },
      ),
      message(
        "p-01-m4",
        mira,
        minutesAgo(12),
        "I can turn the favourite into a full macOS and Windows set by Friday. The spec sheet is attached too.\n\nMira",
        me,
        {
          unread: true,
          // One of each kind the preview panel shows, plus one it can't.
          attachments: [
            pdf("p-01-a2", "icon-spec-sheet.pdf", 96_420),
            file("p-01-a3", "handoff-notes.docx", "application/octet-stream", 2_238),
            file(
              "p-01-a4",
              "icon-budget.xlsx",
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              2_568,
            ),
            file("p-01-a8", "icon-review.pptx", "application/octet-stream", 118_264),
            file("p-01-a5", "favourite-direction.png", "image/png", 23_463),
            file("p-01-a6", "review-list.csv", "text/csv", 175),
            file("p-01-a7", "icon-sources.zip", "application/zip", 3_904_112),
          ],
        },
      ),
    ]),
    thread("p-02", P, ["INBOX", "CATEGORY_UPDATES"], "[pheeme] CI passed on feat/mail-ui", [
      message(
        "p-02-m1",
        ["GitHub", "notifications@ci.example.com"],
        minutesAgo(47),
        "All checks have passed on feat/mail-ui.\n\n- typecheck\n- lint\n- test\n- macOS bundle\n\nView the run on GitHub: https://ci.example.com/runs/1031",
        me,
        { unread: true, html: CI_HTML, remote: true },
      ),
    ]),
    thread("p-03", P, ["INBOX", "STARRED", "Label_2"], "Re: Lisbon in March?", lisbon),
    thread("p-04", P, ["INBOX", "CATEGORY_UPDATES"], "Your October statement is ready", [
      message(
        "p-04-m1",
        ["Tessellate Bank", "statements@tessellate.example"],
        hoursAgo(5),
        "Your statement for the period ending 31 October is now available in online banking. A copy is attached.",
        me,
        { attachments: [pdf("p-04-a1", "statement-2026-10.pdf", 233_870)] },
      ),
    ]),
    thread("p-05", P, ["INBOX"], "Keyboard map feedback", [
      message(
        "p-05-m1",
        ["Priya Raman", "priya@example.org"],
        hoursAgo(10),
        "j/k feels right. I kept reaching for e to archive while reading a thread, so that should work there too.",
        me,
      ),
      message(
        "p-05-m2",
        ["Priya Raman", "priya@example.org"],
        hoursAgo(9),
        "Also: g then i to jump to the inbox is muscle memory from Gmail. Please keep it.\n\nMy notes are at https://example.org/priya/keyboard-map (and a shorter version: www.example.org/keys).\n\nPriya",
        me,
        { unread: true },
      ),
    ]),
    thread("p-06", P, ["INBOX", "CATEGORY_UPDATES", "Label_1"], "Invoice R0042817", [
      message(
        "p-06-m1",
        ["Hetzner Online", "billing@hetzner.example"],
        hoursAgo(26),
        "Your invoice for November is attached. The amount will be debited on the 5th.",
        me,
        { attachments: [pdf("p-06-a1", "R0042817.pdf", 58_204)] },
      ),
    ]),
    thread("p-07", P, ["INBOX", "STARRED"], "Photos from Saturday", [
      message(
        "p-07-m1",
        ["Sam Lindqvist", "sam@example.com"],
        hoursAgo(50),
        "Finally went through them. A few of the harbour ones came out really well; the shared album has all 84.\n\nSam",
        me,
      ),
    ]),
    thread("p-08", P, ["INBOX", "CATEGORY_PROMOTIONS"], "The Tessellate Review, issue 31", [
      message(
        "p-08-m1",
        ["The Tessellate Review", "hello@tessellate.example"],
        hoursAgo(14),
        "Seven small interfaces worth stealing from this month. Read the issue: https://example.com/review/issue-31",
        me,
        { unread: true, html: DARK_NEWSLETTER_HTML, dark: true },
      ),
    ]),
    thread("p-09", P, ["INBOX", "CATEGORY_PROMOTIONS"], "OAuth consent screen verification", [
      message(
        "p-09-m1",
        ["Google Cloud", "noreply@cloud.example.com"],
        hoursAgo(74),
        "Your app is in testing mode. Up to 100 test users can sign in without verification. Refresh tokens for apps in testing expire after 7 days.",
        me,
      ),
    ]),
    thread("p-10", P, ["INBOX", "CATEGORY_SOCIAL"], "Dinner list", [
      message(
        "p-10-m1",
        ["Ana Ribeiro", "ana@example.net"],
        hoursAgo(3),
        "Adding you to the Thursday list. Bring the good olive oil if you still have it.\n\nAna",
        me,
        { unread: true },
      ),
    ]),
    thread("p-11", P, ["INBOX", "CATEGORY_SOCIAL"], "Tomás tagged you in a photo", [
      message(
        "p-11-m1",
        ["Tomás", "notify@circle.example"],
        daysAgo(4),
        'Tomás tagged you in "Harbour walk".',
        me,
      ),
    ]),
    thread("p-12", P, ["INBOX", "CATEGORY_FORUMS"], "[rust-users] Weekly digest", [
      message(
        "p-12-m1",
        ["Rust Users", "digest@users.rust-lang.example"],
        hoursAgo(20),
        "Top threads: sqlx offline mode in CI; keeping a tokio runtime out of Tauri commands.",
        me,
        { unread: true },
      ),
    ]),
    // ── Personal: other mailboxes ──
    thread("p-13", P, ["SENT"], "Re: Icon sketches for the dock", [
      message(
        "p-13-m1",
        me,
        minutesAgo(5),
        "Folded letter, please. Can it hold up in the menu bar at 16 px?",
        mira,
      ),
    ]),
    thread("p-14", P, ["DRAFT", "Label_3"], "Release notes 0.6", [
      message(
        "p-14-m1",
        me,
        minutesAgo(90),
        "The mail UI: category inboxes, a virtualized list, sandboxed HTML bodies and instant actions.",
        me,
      ),
    ]),
    thread("p-15", P, ["Label_2", "Label_1"], "Flight confirmation TP 1031", [
      message(
        "p-15-m1",
        ["TAP Air Portugal", "booking@flytap.example"],
        daysAgo(5),
        "Your booking is confirmed. Itinerary and e-ticket attached.",
        me,
        { attachments: [pdf("p-15-a1", "e-ticket-TP1031.pdf", 141_552)] },
      ),
    ]),
    thread("p-16", P, ["SPAM"], "You have won a prize!!!", [
      message(
        "p-16-m1",
        ["Prize Desk", "win@prizes.example"],
        daysAgo(1),
        "Click here to claim: https://example.com/prize",
        me,
        {
          unread: true,
        },
      ),
    ]),
    thread("p-17", P, ["TRASH"], "Old newsletter", [
      message(
        "p-17-m1",
        ["Old Letters", "news@oldletters.example"],
        daysAgo(9),
        "Nothing to see here.",
        me,
      ),
    ]),

    // A long, plain letter: the kind of email the speed reader offers itself for.
    thread("p-18", P, ["INBOX"], "Notes from the garden club", [
      message(
        "p-18-m1",
        ["Harriet Ames", "harriet@example.net"],
        hoursAgo(3),
        GARDEN_LETTER.replace(/<[^>]+>/g, "\n").replace(/\n{2,}/g, "\n\n"),
        me,
        { html: GARDEN_LETTER },
      ),
      // A short reply: the speed reader reads it, then carries on into the letter it quotes.
      message(
        "p-18-m2",
        me,
        hoursAgo(1),
        "Count me in for Saturday. I'll bring the spare trowels.",
        ["Harriet Ames", "harriet@example.net"],
        {
          html: `<div dir="ltr">Count me in for Saturday. I'll bring the spare trowels.</div><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">Earlier today, Harriet Ames &lt;harriet@example.net&gt; wrote:<br></div><blockquote class="gmail_quote">${GARDEN_LETTER}</blockquote></div>`,
        },
      ),
    ]),

    // A sign-in code: the conversation shows it on a card, and the list row offers to copy it.
    thread("p-19", P, ["INBOX"], "Your temporary Lumen login code", [
      message(
        "p-19-m1",
        ["Lumen", "noreply@lumen.example"],
        minutesAgo(2),
        "Enter this temporary verification code to continue: 779693\n\nDidn't request a code? You can ignore this email.",
        me,
        {
          // Read, so the unread counts other tests expect stay as they were.
          html: `<p>Enter this temporary verification code to continue:</p><table><tr>${[..."779693"].map((d) => `<td style="padding:4px 8px;font-size:24px">${d}</td>`).join("")}</tr></table><p>Didn't request a code? You can ignore this email.</p>`,
        },
      ),
    ]),

    // A cancelled invitation: the card says so and offers no answer.
    thread("p-20", P, ["INBOX"], "Cancelled event: Book club @ Fri 6:30pm (avery@example.com)", [
      message(
        "p-20-m1",
        mira,
        daysAgo(1),
        "This event has been cancelled.\n\nBook club\n\nInvitation from Google Calendar",
        me,
        { attachments: invite("p-20") },
      ),
    ]),
    // A plain email that names a time: Create event from email starts there.
    thread("p-21", P, ["INBOX"], "Coffee next week?", [
      message(
        "p-21-m1",
        jonas,
        hoursAgo(3),
        "Hi Avery,\n\nAre you free for coffee next Thursday at 3pm? Tartine on Guerrero works for me.\n\nJonas",
        me,
      ),
    ]),

    // ── Work ──
    thread("w-01", W, ["INBOX", "STARRED", "Label_10"], "Pilot for the support team", [
      message(
        "w-01-m1",
        dana,
        minutesAgo(25),
        "Hi Avery,\n\nWe'd like ten seats for a month. Does the BYOC setup work with our Workspace admin policy, or do we need an internal OAuth client? Our policy page: https://lumen.example/it/oauth-policy\n\nDana",
        work,
        { unread: true },
      ),
    ]),
    thread("w-02", W, ["INBOX", "Label_11"], "Invoice 2026-114 from Lumen", [
      message("w-02-m1", dana, daysAgo(3), "Invoice for the pilot is attached.", work, {
        attachments: [pdf("w-02-a1", "invoice-2026-114.pdf", 77_310)],
      }),
      message("w-02-m2", work, daysAgo(3) + 3_600_000, "Thanks, forwarding to accounting.", dana),
      message("w-02-m3", dana, daysAgo(2), "Received, thank you.", work),
      message("w-02-m4", work, daysAgo(2) + 600_000, "Paid on Friday.", dana),
    ]),
    thread("w-03", W, ["INBOX", "CATEGORY_SOCIAL"], "Dana viewed your profile", [
      message(
        "w-03-m1",
        ["Peoplenet", "no-reply@peoplenet.example"],
        hoursAgo(6),
        "Dana Whitfield and 3 others viewed your profile this week.",
        work,
        { unread: true },
      ),
    ]),
    thread("w-04", W, ["INBOX", "CATEGORY_SOCIAL"], "Your weekly connections", [
      message(
        "w-04-m1",
        ["Peoplenet", "no-reply@peoplenet.example"],
        daysAgo(5),
        "Five people you may know.",
        work,
      ),
    ]),
    thread("w-05", W, ["INBOX", "CATEGORY_PROMOTIONS"], "Spring upgrade, 30% off", [
      message(
        "w-05-m1",
        ["Workspace Sales", "sales@workspace.example"],
        hoursAgo(8),
        "Move your team to the annual plan before Friday: https://example.com/upgrade",
        work,
        {
          unread: true,
          html: PROMO_HTML,
        },
      ),
    ]),
    thread("w-06", W, ["INBOX", "CATEGORY_UPDATES"], "Security alert: new sign-in", [
      message(
        "w-06-m1",
        ["Account Security", "no-reply@accounts.example"],
        hoursAgo(2),
        "Your account was just signed in to from a new device in Lisbon, Portugal.",
        work,
        {
          unread: true,
          html: SECURITY_HTML,
        },
      ),
    ]),
    thread("w-07", W, ["INBOX", "CATEGORY_UPDATES"], "Receipt for your domain renewal", [
      message(
        "w-07-m1",
        ["Registrar", "billing@registrar.example"],
        daysAgo(8),
        "example.org renewed for one year.",
        work,
        { attachments: [pdf("w-07-a1", "receipt.pdf", 31_820)] },
      ),
    ]),
    thread(
      "w-08",
      W,
      ["INBOX", "CATEGORY_FORUMS"],
      "[tauri] WKWebView sandboxed iframe click events",
      [
        message(
          "w-08-m1",
          ["tauri-apps discussions", "noreply@forum.example.org"],
          minutesAgo(200),
          "Parent-registered listeners do reach a script-less sandboxed frame on macOS 14, as long as allow-same-origin is set.",
          work,
          { unread: true },
        ),
      ],
    ),
    thread("w-09", W, ["INBOX", "CATEGORY_FORUMS"], "[tauri] Release plan for 2.x", [
      message(
        "w-09-m1",
        ["tauri-apps discussions", "noreply@forum.example.org"],
        daysAgo(3),
        "Plugin releases follow the core release.",
        work,
      ),
    ]),
    thread("w-10", W, ["INBOX"], "Weekly sync notes", [
      message(
        "w-10-m1",
        ["Priya Raman", "priya@example.org"],
        hoursAgo(30),
        "Notes from Tuesday:\n\n- ship the mail UI beta\n- start Phase 7 compose\n\nSee https://example.com/roadmap",
        work,
      ),
    ]),
    // An invitation that clashes with a 1:1 (the calendar preview's "Design review", see `calendar.ts`).
    thread("w-13", W, ["INBOX"], "Invitation: Design review @ Thu 2pm – 3pm (avery@example.org)", [
      message(
        "w-13-m1",
        ["Morgan Lee", "morgan@example.org"],
        hoursAgo(4),
        "Morgan Lee has invited you to an event.\n\nDesign review\nWalk through the new onboarding flow, then decide on the copy.\n\nJoin with Google Meet: https://meet.google.com/abc-defg-hij\n\nInvitation from Google Calendar",
        work,
        { attachments: invite("w-13") },
      ),
    ]),
    thread("w-11", W, ["SENT", "Label_10"], "Re: Pilot for the support team", [
      message("w-11-m1", work, minutesAgo(10), "Happy to. Let's find a time this week.", dana),
    ]),
    thread("w-12", W, ["DRAFT"], "Re: Pilot for the support team", [
      message(
        "w-12-m1",
        work,
        minutesAgo(8),
        "Dana, a few notes on the Workspace admin setup:",
        dana,
      ),
    ]),
  ];
}

/** `?threads=N` in preview: N more Inbox conversations, for the memory check (e2e/memory.spec.ts). */
export function generatedThreads(n: number): FixtureThread[] {
  const me = ME["acc-personal"];
  return Array.from({ length: n }, (_, i) => {
    const from: Person = [`Sender ${i % 97}`, `sender${i % 97}@example.net`];
    const text = `Body of generated conversation ${i}.`;
    const date = daysAgo(30) - i * 60_000;
    return thread(`gen-${i}`, "acc-personal", ["INBOX"], `Generated conversation ${i}`, [
      message(`gen-${i}-m1`, from, date, text, me, { unread: i % 3 === 0 }),
    ]);
  });
}

// ── Queries ──────────────────────────────────────────────────────────────────

const isUnread = (t: FixtureThread) => t.messages.some((m) => m.unread);

/** A thread's newest message (fixtures keep messages oldest first). */
export const lastMessage = (t: FixtureThread): FixtureMessage => t.messages[t.messages.length - 1];

export const threadDate = (t: FixtureThread): number => lastMessage(t).date;

/** Whether the thread carries `labelId`; UNREAD follows its messages. */
export function hasLabel(t: FixtureThread, labelId: string): boolean {
  return labelId === "UNREAD" ? isUnread(t) : t.labelIds.includes(labelId);
}

/**
 * Threads in a mailbox, newest first, as `list_threads` selects them. `ALL` is everything but Spam and
 * Trash. `category` narrows an inbox: Primary (`CATEGORY_PERSONAL`) is the inbox minus the tabs still shown.
 */
export function threadsIn(
  threads: FixtureThread[],
  mailbox: string,
  category?: string | null,
  accountIds?: string[],
  hiddenTabs: HiddenTabs = () => [],
): FixtureThread[] {
  let found = threads.filter((t) =>
    mailbox === "ALL" ? !hasLabel(t, "SPAM") && !hasLabel(t, "TRASH") : hasLabel(t, mailbox),
  );
  // No account ids means every account.
  if (accountIds?.length) found = found.filter((t) => accountIds.includes(t.accountId));
  if (category === "CATEGORY_PERSONAL")
    found = found.filter(
      (t) =>
        !OTHER_CATEGORY_IDS.some((c) => !hiddenTabs(t.accountId).includes(c) && hasLabel(t, c)),
    );
  else if (category) found = found.filter((t) => hasLabel(t, category));
  return found.sort((a, b) => threadDate(b) - threadDate(a));
}
