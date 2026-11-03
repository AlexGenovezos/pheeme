// The in-app setup guide (design doc §4 item 1). docs/google-cloud-setup.md mirrors
// this text: change both together.

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export type StepId =
  | "welcome"
  | "project"
  | "gmail-api"
  | "calendar-api"
  | "consent"
  | "branding"
  | "publish"
  | "client"
  | "credentials"
  | "unverified"
  | "authorize";

export interface CopyValue {
  label: string;
  value: string;
}

export interface GuideStep {
  id: StepId;
  /** Short name for the progress rail. */
  short: string;
  title: string;
  /** What to do, in order. */
  actions: string[];
  why?: string;
  link?: { label: string; url: string };
  copy?: CopyValue[];
  /** Path under public/ once captured; the slot renders only when set. */
  screenshot?: string;
}

export const STEPS: GuideStep[] = [
  {
    id: "welcome",
    short: "Welcome",
    title: "Connect Gmail with your own Google Cloud app",
    actions: [
      "Pheeme reaches Gmail through a Google Cloud app that you own. Setting it up takes about 15 minutes and costs nothing.",
      "You do this once. Other Google accounts can share the same app later.",
      "You can quit at any point: Pheeme picks up at the same step next time.",
    ],
    why: "There's no Pheeme server. Your mail goes straight from Google to this computer, and nobody has to pay Google for access.",
  },
  {
    id: "project",
    short: "Create a project",
    title: "Create a Google Cloud project",
    actions: [
      "Open Google Cloud Console and sign in. Any Google account works; it doesn't have to be the mailbox you'll connect.",
      "Name the project, for example Pheeme, and click Create.",
      "Check that the new project is selected in the project picker at the top of the page.",
    ],
    why: "The project holds your app's settings and its sign-in client. It's free and stays private to you.",
    link: { label: "Open New Project", url: "https://console.cloud.google.com/projectcreate" },
    copy: [{ label: "Project name", value: "Pheeme" }],
  },
  {
    id: "gmail-api",
    short: "Enable Gmail API",
    title: "Turn on the Gmail API",
    actions: [
      "Open the Gmail API page and check your new project is selected.",
      "Click Enable.",
    ],
    why: "Pheeme reads, labels and sends your mail through the Gmail API.",
    link: {
      label: "Open Gmail API",
      url: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
    },
  },
  {
    id: "calendar-api",
    short: "Enable Calendar API",
    title: "Turn on the Google Calendar API",
    actions: [
      "Open the Google Calendar API page and check your project is selected.",
      "Click Enable.",
    ],
    why: "Calendar is coming to Pheeme. Enabling it now means you won't repeat this setup later. Pheeme won't ask for calendar access until you open the calendar.",
    link: {
      label: "Open Calendar API",
      url: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
    },
  },
  {
    id: "consent",
    short: "Sign-in screen",
    title: "Set up the sign-in screen",
    actions: [
      "Open Google Auth Platform and click Get started.",
      "App information: enter the app name below and your email as the support email.",
      "Audience: choose External. Choose Internal only for a Google Workspace project used by your organization's accounts alone.",
      "Contact information: your email. Agree to the policy and click Create.",
      "Optional: under Data access, add the scopes below. Pheeme asks for them when you sign in either way.",
    ],
    why: "Google shows this screen when you sign in. The app is yours, so you're both its developer and its only user.",
    link: { label: "Open Google Auth Platform", url: "https://console.cloud.google.com/auth/overview" },
    copy: [
      { label: "App name", value: "Pheeme" },
      { label: "Scopes (optional)", value: GMAIL_SCOPES.join(",") },
    ],
  },
  {
    id: "branding",
    short: "Add Pheeme's links",
    title: "Add Pheeme's links to the branding",
    actions: [
      "Open the Branding page and check your project is selected.",
      "Under App domain, paste the home page, privacy policy and terms of service links below.",
      "Under Authorized domains, click Add domain and enter pheeme.app.",
      "Click Save.",
    ],
    why: "Google keeps Publish app turned off until the app has a home page, privacy policy and terms of service. These are Pheeme's own pages, so you don't need a website. They give nobody access to your project or your mail.",
    link: { label: "Open Branding", url: "https://console.cloud.google.com/auth/branding" },
    copy: [
      { label: "Application home page", value: "https://pheeme.app" },
      { label: "Application privacy policy link", value: "https://pheeme.app/privacy" },
      { label: "Application terms of service link", value: "https://pheeme.app/terms" },
      { label: "Authorized domain", value: "pheeme.app" },
    ],
  },
  {
    id: "publish",
    short: "Publish the app",
    title: "Publish the app",
    actions: [
      "Open the Audience page.",
      "Under Publishing status, click Publish app, then Confirm.",
      "If Publish app is greyed out, go back to Branding, check all four values from the last step are there, click Save, then reload this page.",
      "If you chose Internal when setting up the sign-in screen, skip this step.",
    ],
    why: "An app left in Testing signs you out of Gmail every 7 days. Publishing stops that. It doesn't submit anything for review or make the app public: only people you give the client ID to can use it.",
    link: { label: "Open Audience", url: "https://console.cloud.google.com/auth/audience" },
  },
  {
    id: "client",
    short: "Create a client",
    title: "Create a desktop client",
    actions: [
      "Open Clients and click Create client.",
      "Application type: Desktop app. Name: Pheeme desktop.",
      "Click Create. Google shows the client ID and secret: keep that dialog open, or download the JSON, for the next step.",
    ],
    why: "A Desktop app client lets Pheeme sign you in through your browser and receive the result on this computer. Other client types fail with redirect_uri_mismatch.",
    link: { label: "Open Create client", url: "https://console.cloud.google.com/auth/clients/create" },
    copy: [
      { label: "Application type", value: "Desktop app" },
      { label: "Name", value: "Pheeme desktop" },
    ],
  },
  {
    id: "credentials",
    short: "Paste credentials",
    title: "Paste your client ID and secret",
    actions: ["Copy both values from the dialog Google showed when you created the client."],
    why: "Pheeme keeps the secret in your system keychain, never in its database.",
  },
  {
    id: "unverified",
    short: "Before you sign in",
    title: "Google will warn you first",
    actions: [
      "Google will say “Google hasn't verified this app”. That's expected: the app is yours, and Google only verifies apps that are offered to other people.",
      "Click Advanced, then Go to Pheeme (unsafe).",
      "Leave every box ticked, especially Gmail, and click Continue.",
    ],
    why: "Pheeme asks to read, organize and send your mail, and to see your name and email address. It can't permanently delete mail, only move it to Trash.",
  },
  {
    id: "authorize",
    short: "Sign in",
    title: "Finish signing in in your browser",
    actions: [],
  },
];

export const stepIndex = (id: StepId) => STEPS.findIndex((step) => step.id === id);
export const stepById = (id: StepId) => STEPS[stepIndex(id)];
