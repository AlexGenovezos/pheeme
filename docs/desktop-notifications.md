# Desktop notifications and tray

In **Settings → Notifications**, turn on notifications separately for each account.
The choice is saved on this device. Accounts start with notifications off. On
macOS, enabling the first account asks for system permission; if blocked, allow
Pheeme in **System Settings → Notifications** and enable the account again.
Windows and Linux use the notification preferences supplied by the desktop.

Alerts contain the sender, subject and a short preview of newly delivered unread
**Primary** mail. They include replies to existing conversations. Promotions,
Social, Updates, Forums, read mail, Spam, Trash, sent mail and drafts do not alert.
Initial downloads, background cache filling, search downloads, label changes and
expired-history resyncs stay silent. History replay does not repeat an alert.
Multiple messages arriving in one conversation during one sync produce one alert.

Click an alert to bring Pheeme forward and open its conversation in the owning
account. Focus / Do Not Disturb, banners, sounds and lock-screen previews remain
controlled by the OS. Pheeme does not request critical or time-sensitive alerts.
Notifications use the existing sync loop, so they arrive on its next successful
sync (normally within 90 seconds), rather than through a separate polling timer.

The menu bar / system tray shows the number of unread cached inbox conversations
across all accounts, matching All Inboxes. macOS shows the number beside a template
envelope icon; Windows and Linux show it on the icon (up to `99+`) and in the menu.
The count catches up as mail is cached. The menu offers **Open Pheeme**, **Mark all
read** for each account (all its cached mail, including archived conversations),
and **Quit Pheeme**. Mark all read uses the same optimistic outbox as mail actions
and synchronizes the changes to Gmail. Left-click toggles the window on macOS and
Windows; on Linux use the menu's Open action.

Closing the window keeps sync and notifications running when a tray is available.
Choose **Quit Pheeme** (or the normal app Quit command) to stop the process. Opening
Pheeme from the Dock on macOS restores the hidden window. Linux needs an
AppIndicator / StatusNotifier tray host; without one, closing exits normally.
Quitting the app stops sync and notifications; Pheeme is not a system service.

Native notification testing requires an installed/bundled app on macOS and
Windows, so the OS can associate permissions and activation with Pheeme's app
identity. Plain browser preview supports the settings UI without sending alerts.

## Acceptance checks on installed builds

- Enable one of two accounts and send a new Primary message to each. Only the
  enabled account alerts, with the expected sender, subject and preview.
- Close the window, then click a new alert. The window returns to the correct
  account and conversation. Repeat with Settings open and while adding an account.
- Reply to an existing conversation; it alerts. Move an old message into Inbox,
  read mail elsewhere, or receive Promotions/Social mail; these stay silent.
- Restart and force a history resync: no repeated alert for cached messages.
- Deny notification permission; the setting explains recovery. Test system Focus /
  Do Not Disturb, notification sounds and preview privacy settings.
- Check the unread tray count after deliveries, reading, archiving, removing an
  account and restarting. Mark all read for one account; the other stays unread,
  and Gmail receives the changes. Open and Quit work from the tray menu.
- On macOS, verify the menu bar icon in both appearances and reopen from the Dock.
  On Windows, verify the installed app's toast identity and click activation.
  On Linux, test with a notification daemon and a StatusNotifier host, then without
  the host to verify the normal close/exit fallback.
