<img src="public/pheeme-mark.svg" width="64" height="64" alt="">

# Pheeme

A fast, open-source desktop client for Gmail, with Google Calendar coming next, for macOS, Windows and Linux.

- **Gmail-native:** uses the Gmail API, with real labels and category tabs (Primary, Social, Promotions, Updates, Forums).
- **Instant:** reads come from a local cache and actions apply immediately, with Gmail syncing in the background.
- **Free to run:** you bring your own Google Cloud OAuth client, so there's no subscription and no server between you and your mail.
- **Multi-account:** one combined inbox, or switch between accounts.

> **Status:** beta. Pheeme works as a day-to-day Gmail client and updates itself; 1.0 will be the first non-beta release.

Website: [pheeme.app](https://pheeme.app) (source in [`site/`](site/))

## Install

Download the latest build from [Releases](https://github.com/AlexGenovezos/pheeme/releases/latest). Versions are two-part (`v0.2`); 0.x is beta, and 1.0 is when Pheeme leaves beta.

- **macOS (Apple Silicon):** open the `.dmg` and drag Pheeme to Applications.
  The app is signed with a Developer ID and notarized by Apple, so it opens
  without a warning. There's no Intel build.
- **Windows (x64):** run the `-setup.exe` installer. It isn't code-signed, so
  SmartScreen may warn about it: choose More info, then Run anyway.
- **Linux (x86_64):** install the deb with `sudo apt install ./Pheeme_*.deb`,
  or `chmod +x Pheeme_*.AppImage` and run it. Pheeme keeps sign-in tokens in
  the system keychain, so it needs a running, unlocked Secret Service provider
  such as GNOME Keyring or KWallet; without one, sign-in stops with a message
  saying so.

Pheeme checks for updates on launch and every 6 hours, and asks before
restarting to apply one.

### First launch

Pheeme has no server of its own: it signs in to Gmail with an OAuth client you
create in your own Google Cloud project, which is free. The app walks you
through it on first launch, and the same steps are in
[Google Cloud setup](docs/google-cloud-setup.md). It takes about 15 minutes,
once. To use the same client on another computer, send it over your local
network from Settings instead of creating a new one
([Transfer client credentials](docs/local-credential-transfer.md)).

## Docs

Using Pheeme:

- [Google Cloud setup](docs/google-cloud-setup.md): create the OAuth client Pheeme signs in with (the app also walks you through it)
- [Transfer client credentials](docs/local-credential-transfer.md): securely reuse your Google Cloud client on another device over your local network
- [Desktop notifications and tray](docs/desktop-notifications.md): per-account alerts, background sync and OS acceptance checks
- [Themes](docs/themes.md): custom theme files and importing a VS Code theme
- [Mods](docs/mods.md): install personal features and write integrations without maintaining a fork
- [Local diagnostics](docs/diagnostics.md): always-on logs and where to find them

Building Pheeme:

- [Design](docs/superpowers/specs/2026-10-31-mail-calendar-client-design.md): scope, priorities and roadmap
- [Technical plan](Gmail%20client%20project%20plan.md): the detailed implementation reference
- [Performance checks](docs/performance.md): the CI benchmarks, leak checks and nightly memory budgets

## Develop on macOS

```bash
git clone https://github.com/AlexGenovezos/pheeme.git
cd pheeme
scripts/setup-macos.sh
npm run tauri dev
```

`npm run dev` alone serves the UI in a plain browser with a fake backend
(`src/preview/install.ts`), for UI work without a native build. Query
parameters shape it: the default opens the shell with fixture mail;
`?accounts=0` starts onboarding, `?accounts=1` starts with one connected account,
`?fail=invalid_grant` makes sign-in fail with that code, `?delay=ms` sets how
long sign-in takes.

The setup script checks the Apple and Rust toolchains, installs the Apple Silicon
Rust target and SQLx CLI, and runs `npm ci`. To test the real macOS keychain
integration once, run:

```bash
cd src-tauri
SQLX_OFFLINE=true cargo test -- --ignored keyring_store_round_trip_on_this_os
```

## Releasing

Versions are two-part (`v0.2`): 0.x is beta, and 1.0 is when Pheeme leaves beta.

1. `npm run release:prepare -- 0.2` sets the version (files store `0.2.0`;
   Cargo needs three parts) and drafts `docs/releases/v0.2.md` from the PRs
   merged since the last tag.
2. Write the notes, until `npm run release:check -- 0.2` passes.
3. Commit as `release: v0.2` and merge it through a PR.
4. After the merge: `git tag v0.2 && git push origin v0.2`
5. The Release workflow checks the version and notes, creates a draft release,
   builds macOS (Apple Silicon), Windows and Linux,
   checks `latest.json`, then publishes with the notes as the release text. Release builds restore a Rust cache that the workflow's dry run
   saves on `main` (when dependencies or the toolchain change, and twice a
   week); without it a release compiles every crate from scratch.

The full runbook, including the website and what to do when a step fails, is
`.claude/skills/release/SKILL.md`.

Signing setup:

- macOS signing and notarization need a one-time
  `scripts/setup-release-secrets-macos.sh` run on a Mac with your Developer ID
  certificate. Without those secrets the macOS build is unsigned.
- The updater private key lives in the GitHub secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and in
  Alex's password manager. If the key is lost, existing installs can't
  auto-update.

## License

MIT

The desktop app icon is a line engraving of the Fama statue in Dresden, adapted from
["Gold (82911013)"](https://commons.wikimedia.org/wiki/File:Gold_(82911013).jpeg) by Etrick,
licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). We cropped it, cut it
out and redrew it as vector lines (`site/scripts/build-fama-icon.sh`).
