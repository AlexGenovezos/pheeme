# Desktop notifications and tray

When an account is first connected (or on the first launch after upgrading),
Pheeme asks whether to turn on notifications. **Turn on** enables them for every
account that hasn't been asked yet; dismissing the prompt leaves them off and it
isn't shown again for those accounts. Change the choice per account any time in
**Settings → Notifications**. The choice is saved on this device. On macOS,
turning notifications on asks for system permission; if blocked, allow Pheeme in
**System Settings → Notifications** and enable the account in Settings.
Windows and Linux use the notification preferences supplied by the desktop.

Alerts contain the sender, subject and a short preview of newly delivered unread
**Primary** mail. They include replies to existing conversations. Promotions,
Social, Updates, Forums, read mail, Spam, Trash and drafts do not alert. Mail you
send to yourself alerts when it arrives unread in the Inbox; your own replies and
other sent mail (not in the Inbox, or already read) do not.
Initial downloads, background cache filling, search downloads, label changes and
expired-history resyncs stay silent. History replay does not repeat an alert.
Multiple messages arriving in one conversation during one sync produce one alert.

Click an alert to bring Pheeme forward and open its conversation in the owning
account. Focus / Do Not Disturb, banners, sounds and lock-screen previews remain
controlled by the OS. Pheeme does not request critical or time-sensitive alerts.
Notifications use the existing sync loop, which asks Gmail for new mail every 10
seconds, so an alert normally appears within about 10 seconds of the mail arriving.
A check that finds nothing new costs one small Gmail request; label names, colours
and counts still refresh at least every 90 seconds.

The menu bar / system tray shows the number of unread cached inbox conversations
across all accounts, matching All Inboxes. macOS shows the number beside a template
envelope icon; Windows and Linux show it on the icon (up to `99+`) and in the menu.
The count catches up as mail is cached. The menu offers **Open Pheeme** and **Quit
Pheeme**. Left-click toggles the window on macOS and Windows; on Linux use the
menu's Open action. Turn the icon off with **Settings → Notifications → Show icon in
the menu bar or notification area**; without it, closing the window quits Pheeme.

Closing the window keeps sync and notifications running when a tray is available.
Choose **Quit Pheeme** (or the normal app Quit command) to stop the process. Opening
Pheeme from the Dock on macOS restores the hidden window. Linux needs an
AppIndicator / StatusNotifier tray host; without one, closing exits normally.
Quitting the app stops sync and notifications; Pheeme is not a system service.

Native notification testing requires an installed/bundled app on macOS and
Windows, so the OS can associate permissions and activation with Pheeme's app
identity. Plain browser preview supports the settings UI without sending alerts.

## Acceptance checks on installed builds

- Connect an account: the "Turn on notifications?" prompt appears once. Turn on
  and dismiss both persist across restarts; adding another account asks again.
- Send test mail from a different address, or mail yourself: a message to your own
  address alerts when it arrives unread in the Inbox. Check the diagnostic log for
  `notification permission at startup` and `desktop alerts delivered`.
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
  account and restarting. Open and Quit work from the tray menu; it has no mark-read
  items. Turn the icon off in Settings: it disappears, closing the window quits,
  and it stays off after restart. Turn it back on and it returns with the count.
- On macOS, verify the menu bar icon in both appearances and reopen from the Dock.
  On Windows, verify the installed app's toast identity and click activation.
  On Linux, test with a notification daemon and a StatusNotifier host, then without
  the host to verify the normal close/exit fallback.
