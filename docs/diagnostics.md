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
version/platform details, sync errors, and Gmail retry diagnostics (HTTP status,
rate-limit reason, retry attempts and delays). Requests' authorization headers,
OAuth secrets, and message bodies are not added to the logs. Error messages and
local paths can still contain personal information; review logs before sharing.

The default records Pheeme events at `info` and third-party events at `warn`.
Developers can override the filter with `RUST_LOG`; output also goes to stderr
when running from a terminal. If the log directory cannot be opened, Pheeme
continues with stderr logging. Logging does not upload anything.

Versions through 0.8.0 logged only to stdout. Normal macOS launches discarded
that output, so their earlier Gmail failures cannot be recovered from these files.
