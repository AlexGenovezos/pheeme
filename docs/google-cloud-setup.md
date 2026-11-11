# Set up your Google Cloud app

Pheeme reaches Gmail through a Google Cloud app that you own ("bring your own
client"). Setup takes about 15 minutes, costs nothing, and you only do it once:
other Google accounts can share the same app, and your other devices can copy it
over.

This is what keeps Pheeme free and private:

- **Completely free.** Google gives your own app Gmail access at no charge. No
  server, no subscription.
- **You own your data.** Mail goes straight from Google to your computer.
  Nobody in between, not even us.

The welcome screen also has a switch for anonymous usage stats (once a day, a
random ID, the app version, your operating system and chip type; see the
[privacy policy](https://pheeme.app/privacy)). It's on by default, and you can
change it later in Settings › Diagnostics.

Pheeme explains this on first launch, then walks you through these steps
itself. This page mirrors that intro and guide (`src/onboarding/steps.ts`); keep
the two in step.

## 1. Create a project

1. Open [New Project](https://console.cloud.google.com/projectcreate) and sign
   in. Any Google account works; it doesn't have to be the mailbox you connect.
2. Name it, for example `Pheeme`, and click **Create**.
3. Check the new project is selected in the project picker at the top.

## 2. Turn on the Gmail API

Open the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
page, check your project is selected, and click **Enable**.

## 3. Turn on the People API (optional)

Open the [People API](https://console.cloud.google.com/apis/library/people.googleapis.com)
page and click **Enable**. As you type a recipient, Pheeme suggests people from
your mail; with the People API it suggests your Google Contacts too. Pheeme
only reads them. You can turn it on later: Settings › Contacts walks you
through it.

## 4. Turn on the Google Calendar API

Open the [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
page and click **Enable**. Pheeme's Calendar shows, creates and changes your
events and answers invites through the Calendar API. Pheeme doesn't ask for
calendar access until you open the calendar.

## 5. Turn on the Google Tasks API (optional)

Open the [Google Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com)
page and click **Enable**. Pheeme shows and changes your Google Tasks in the
Tasks panel and on the calendar. Without it the calendar still works. Pheeme
asks for tasks access together with calendar access, when you open the
calendar.

## 6. Set up the sign-in screen

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview)
   and click **Get started**.
2. **App information:** app name `Pheeme`, and your email as the support email.
3. **Audience:** External. Choose Internal only for a Google Workspace project
   used by your organization's accounts alone.
4. **Contact information:** your email. Agree to the policy and click **Create**.
5. Optional: under **Data access**, add these scopes. Pheeme requests them at
   sign-in either way. `gmail.settings.basic` only lets Pheeme save sender
   rules (Gmail filters that file a sender's mail in an inbox tab), the two
   contacts scopes only let it read your contacts to suggest recipients, and
   the calendar scopes (the last four) are asked for when you first open the
   calendar.
   ```
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/gmail.settings.basic
   https://www.googleapis.com/auth/contacts.readonly
   https://www.googleapis.com/auth/contacts.other.readonly
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/userinfo.profile
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.calendarlist.readonly
   https://www.googleapis.com/auth/calendar.settings.readonly
   https://www.googleapis.com/auth/tasks
   ```

## 7. Add Pheeme's links to the branding

1. Open [Branding](https://console.cloud.google.com/auth/branding) and check
   your project is selected.
2. Under **App domain**, paste:
   - **Application home page:** `https://pheeme.app`
   - **Application privacy policy link:** `https://pheeme.app/privacy`
   - **Application terms of service link:** `https://pheeme.app/terms`
3. Under **Authorized domains**, click **Add domain** and enter `pheeme.app`.
4. Leave **App logo** empty.
5. Click **Save**.

Google keeps **Publish app** turned off until the app has a home page, privacy
policy and terms of service. These are Pheeme's own pages, so you don't need a
website. They give nobody access to your project or your mail. A logo would make
Google ask you to prove you own pheeme.app, which you can't, and the app works
without one.

## 8. Publish the app

Open [Audience](https://console.cloud.google.com/auth/audience). Under
**Publishing status**, click **Publish app**, then **Confirm**. (Internal apps
skip this step.)

If **Publish app** is greyed out, go back to **Branding**, check all four values
from step 7 are there, click **Save**, then reload **Audience**.

An app left in **Testing** signs you out of Gmail every 7 days. Publishing stops
that. It doesn't submit anything for review or make the app public: only people
you give the client ID to can use it.

## 9. Create a desktop client

1. Open [Create client](https://console.cloud.google.com/auth/clients/create).
2. **Application type:** Desktop app. **Name:** `Pheeme desktop`.
3. Click **Create**. Google shows the client ID and secret; keep the dialog
   open, or download the JSON.

Use the **Desktop app** type: other types fail with `redirect_uri_mismatch`.

## 10. Connect Pheeme

1. Paste the client ID and secret into Pheeme (or paste the downloaded JSON
   file's contents into the client ID box). The secret is stored in your system
   keychain, never in Pheeme's database.
2. Pheeme opens Google's sign-in page in your browser. Google says **"Google
   hasn't verified this app"**. That's expected: the app is yours, and Google
   only verifies apps offered to other people. Click **Advanced**, then **Go to
   Pheeme (unsafe)**.
3. Leave every box ticked, especially Gmail, and click **Continue**. Pheeme can
   read, organize and send your mail, but can't permanently delete it (only move
   it to Trash).
4. When the browser says you can close the tab, go back to Pheeme.

To add another account, use **Add account**. It reuses this app by default; pick
"Use a different OAuth client" for a work account whose administrator requires
its own.

## Troubleshooting

| You see | Fix |
|---|---|
| `Error 400: redirect_uri_mismatch` | The client isn't a Desktop app client. Create a Desktop app client and use its ID and secret. |
| `Error 401: invalid_client` / "The OAuth client was not found" | Typo in the client ID, or the client was deleted. Copy it again from [Clients](https://console.cloud.google.com/auth/clients). |
| `Error 403: org_internal` | The audience is Internal: only accounts in that Workspace organization can sign in. Use one, or switch the audience to External. |
| `Error 403: access_denied` ("has not completed the Google verification process") | The app is in Testing and this account isn't a test user. Publish the app, or add the address under Test users. |
| `Error 400: admin_policy_enforced` | Your Workspace administrator blocks unapproved apps. Ask them to trust your client ID (Admin console → Security → API controls). |
| **Publish app** is greyed out ("complete your configuration on the Branding page") | The Branding page is missing Pheeme's links. Add the three links and the `pheeme.app` domain from step 7, then click **Save**. |
| `Missing domain: pheeme.app` on the Branding page | Under **Authorized domains**, click **Add domain**, enter `pheeme.app`, then click **Save**. |
| "Branding verification issues": `The website of your home page URL "https://pheeme.app" is not registered to you` | An app logo was uploaded, and a logo needs Google's brand verification, which only the owner of pheeme.app can pass. Under **App logo**, click **Remove**, then **Save**. Don't ask Google to review it again: the app signs in without brand verification. |
| Signed out after 7 days | The app is still in Testing. Publish it (step 8), then sign in again. |
| "No system keychain is available" (Linux) | Install and unlock a Secret Service provider such as GNOME Keyring or KWallet. |
| "Your keychain is locked" (macOS) | Unlock your Mac and try again. If you started Pheeme from a terminal over SSH, start it on the Mac itself: macOS only lets apps in your desktop session use the keychain. |
