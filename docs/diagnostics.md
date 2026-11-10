# Local diagnostics

Pheeme writes diagnostic logs automatically, including when opened from Finder,
the Start menu, or a desktop launcher. Files rotate after 5 MiB, preserving whole
log entries; Pheeme keeps the seven most recent files across launches. Logging
stays on during normal use.

- **macOS:** `~/Library/Logs/app.pheeme.desktop/`
- **Windows:** `%LOCALAPPDATA%\app.pheeme.desktop\logs\`
- **Linux:** `$XDG_DATA_HOME/app.pheeme.desktop/logs/`, or
  `~/.local/share/app.pheeme.desktop/logs/` when `XDG_DATA_HOME` is unset.

The active file is `pheeme.log`, with older files numbered `.1` through `.6`
(`.1` is newest). Timestamps use UTC. The files contain startup
version/platform details, sync errors, Gmail retry diagnostics (HTTP status,
rate-limit reason, retry attempts and delays), and how long opened conversations
took: `thread opened` times the backend read (logged when over 1 s or fetched
from Gmail), and `thread shown` times the window from the click until the
conversation painted and every image in it loaded or failed (logged when over
1 s). The last 50 of each are also kept in memory for Send diagnostics
(`recentOpens` and `recentShown` in `summary.json`).

Every mail change (archive, read, star, label, move to an inbox category, trash) is
recorded when it's made (`change queued`: its `op` id, thread ids, labels added and
removed) and again when Gmail applies it (`Gmail applied the change`, with how many
messages and attempts), waits on a problem the first time (`change waiting for
Gmail`), or refuses it (`Gmail rejected a queued change`); match them by `op`. A
thread id leads back to its sender through the local database. Sender rules (future
mail from a sender to a category) are recorded when saved, undone or deleted, with
the sender, category and Gmail filter ids. `read saved sign-ins from the keychain`
says once per launch how long the keychain took (a long wait means an access prompt
nobody answered); while the keychain can't be read (the Mac asleep or locked), sync
says so once rather than at every attempt. Requests' authorization headers,
OAuth secrets, and message bodies are not added to the logs. Error messages and
local paths can still contain personal information; review logs before sharing.

The default records Pheeme events at `info` and third-party events at `warn`.
Developers can override the filter with `RUST_LOG`; output also goes to stderr
when running from a terminal. If the log directory cannot be opened, Pheeme
continues with stderr logging. Logging does not upload anything.

Versions through 0.8.0 logged only to stdout. Normal macOS launches discarded
that output, so their earlier Gmail failures cannot be recovered from these files.
